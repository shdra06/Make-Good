// The matching engine: given what the merchant says is affected, and the
// records we hold, decide which customers are affected and how well the
// records establish it.
//
// Pure functions only. No database, no clock, no AI. The same input always
// gives the same output, and every conclusion carries the records behind it.
//
// Two rules shape everything here:
//   1. PayPal never knows the batch or serial of a product. Unit-level proof
//      can only come from the merchant's own fulfilment or packing records.
//   2. A purchase date or a ship date does not prove which batch a customer
//      received. Dates can support a conclusion; they cannot settle it.

import type {
  CandidateDraft,
  Classification,
  Evidence,
  ExclusionCode,
  IncidentScope,
  InventoryBatchRecord,
  MatchInput,
  MatchOutput,
  MatchStats,
  OrderLineRecord,
  OrderRecord,
  PaymentLinkRecord,
  PaymentRecord,
  RecommendedAction,
} from "./types.ts";

export const normSku = (sku: string): string => sku.trim().toUpperCase();
/** Batch and serial codes are compared ignoring case, spaces and punctuation ("LOT 24-B" equals "lot24b"). */
export const normCode = (code: string): string => code.replace(/[^a-z0-9]/gi, "").toUpperCase();

const day = (d: Date): string => d.toISOString().slice(0, 10);

function emptyStats(): MatchStats {
  return {
    linesConsidered: 0,
    outsideOrderWindow: 0,
    clearedByBatchRecord: 0,
    clearedByInventory: 0,
    clearedByShipWindow: 0,
    legitimateRepeatPurchases: 0,
    byClassification: {},
    excluded: {},
  };
}

function finish(candidates: CandidateDraft[], stats: MatchStats): MatchOutput {
  for (const c of candidates) {
    if (c.status === "excluded") stats.excluded[c.exclusionCode ?? "other"] = (stats.excluded[c.exclusionCode ?? "other"] ?? 0) + 1;
    else stats.byClassification[c.classification] = (stats.byClassification[c.classification] ?? 0) + 1;
  }
  return { candidates, stats };
}

export function runMatch(input: MatchInput): MatchOutput {
  switch (input.scope.type) {
    case "product":
      return matchProduct(input.scope, input);
    case "duplicate_charge":
      return matchDuplicateCharges(input.scope, input);
    case "overcharge":
      return matchOvercharge(input.scope, input);
    case "service_period":
      return matchServicePeriod(input.scope, input);
  }
}

// ---------- shared: which PayPal payment paid for an order ----------

type PaymentChoice = {
  payment: PaymentRecord | null;
  link: PaymentLinkRecord | null;
  reasons: string[];
  missing: string[];
  evidence: Evidence[];
};

function choosePayment(order: OrderRecord, payments: Map<string, PaymentRecord>): PaymentChoice {
  const out: PaymentChoice = { payment: null, link: null, reasons: [], missing: [], evidence: [] };
  const linked = order.paymentLinks
    .map((link) => ({ link, payment: payments.get(link.paymentId) }))
    .filter((x): x is { link: PaymentLinkRecord; payment: PaymentRecord } => x.payment !== undefined);

  if (linked.length === 0) {
    if (order.paymentMethod === "paypal" || order.paymentMethod === "unknown") {
      out.missing.push("No PayPal payment has been matched to this order.");
    } else {
      out.reasons.push(`The order was paid by ${order.paymentMethod}, not PayPal, so there is no PayPal payment to refund.`);
    }
    return out;
  }
  const exact = linked.filter((x) => x.link.strength === "exact");
  const pool = exact.length > 0 ? exact : linked;
  // Several payments for one order (a split payment): use the largest, and say so.
  const chosen = [...pool].sort((a, b) => b.payment.grossMinor - a.payment.grossMinor)[0]!;
  if (pool.length > 1) {
    out.reasons.push(`The order has ${pool.length} PayPal payments. The largest (${chosen.payment.transactionId}) is used.`);
  }
  out.payment = chosen.payment;
  out.link = chosen.link;
  out.evidence.push({
    source: "order_payment_link",
    recordId: chosen.payment.id,
    fact: `PayPal payment ${chosen.payment.transactionId} is tied to order ${order.orderNumber}: ${chosen.link.detail}`,
    strength: chosen.link.strength === "exact" ? "proves" : "weak",
  });
  if (chosen.link.strength === "heuristic") {
    out.missing.push("The link between this order and the PayPal payment is a best guess and has not been confirmed.");
  }
  return out;
}

/** Exclusions that come from the state of the payment itself. */
function paymentExclusion(payment: PaymentRecord | null): { code: ExclusionCode; reason: string; action: RecommendedAction } | null {
  if (!payment) return null;
  if (payment.disputeState === "open") {
    return {
      code: "dispute_open",
      reason: `A PayPal dispute is open on payment ${payment.transactionId}. Refunding outside the dispute could pay the customer twice.`,
      action: "resolve_dispute",
    };
  }
  if (payment.refundedMinor >= payment.grossMinor) {
    return {
      code: "already_refunded",
      reason: `Payment ${payment.transactionId} has already been refunded in full.`,
      action: "none",
    };
  }
  return null;
}

function remainingQuantity(line: OrderLineRecord): { remaining: number; returned: number; replaced: boolean } {
  let returned = 0;
  let replaced = false;
  for (const adj of line.adjustments) {
    if (adj.kind === "return" || adj.kind === "cancellation") returned += adj.quantity;
    if (adj.kind === "replacement") replaced = true;
  }
  return { remaining: Math.max(0, line.quantity - returned), returned, replaced };
}

function actionFor(classification: Classification, choice: PaymentChoice): { action: RecommendedAction; needsConfirmation: boolean } {
  if (classification === "strong_multi_source") return { action: "merchant_review", needsConfirmation: true };
  if (classification !== "exact_unit") return { action: "ask_customer", needsConfirmation: true };
  if (!choice.payment) {
    return choice.missing.length > 0
      ? { action: "confirm_payment_link", needsConfirmation: true }
      : { action: "pay_outside_paypal", needsConfirmation: false };
  }
  return choice.link?.strength === "heuristic"
    ? { action: "confirm_payment_link", needsConfirmation: true }
    : { action: "pay", needsConfirmation: false };
}

// ---------- product incidents (defects, recalls, cancelled events) ----------

type UnitTally = Record<"exact_unit" | "strong_multi_source" | "likely" | "product_only", number>;

function matchProduct(scope: Extract<IncidentScope, { type: "product" }>, input: MatchInput): MatchOutput {
  const stats = emptyStats();
  const candidates: CandidateDraft[] = [];
  const skus = new Set(scope.skus.map(normSku));
  const affectedBatches = new Set(scope.batchCodes.map(normCode));
  const affectedSerials = new Set(scope.serials.map(normCode));
  const unitScoped = affectedBatches.size > 0 || affectedSerials.size > 0;
  const warehouses = new Set(scope.warehouses);
  const orderedFrom = scope.orderedFrom ? new Date(scope.orderedFrom) : null;
  const orderedTo = scope.orderedTo ? new Date(scope.orderedTo) : null;
  const shippedFrom = scope.shippedFrom ? new Date(scope.shippedFrom) : null;
  const shippedTo = scope.shippedTo ? new Date(scope.shippedTo) : null;
  const hasShipWindow = shippedFrom !== null || shippedTo !== null;
  const inShipWindow = (d: Date) => (!shippedFrom || d >= shippedFrom) && (!shippedTo || d <= shippedTo);
  const payments = new Map(input.payments.map((p) => [p.id, p]));
  const linkedPaymentIds = new Set(input.orders.flatMap((o) => o.paymentLinks.map((l) => l.paymentId)));
  const unitPrices = new Set<string>();

  /** What the inventory records say about stock shipping from a warehouse on a date. */
  const stockShipping = (sku: string, warehouse: string, at: Date): { affected: InventoryBatchRecord[]; others: InventoryBatchRecord[] } => {
    const shipping = input.batches.filter(
      (b) =>
        normSku(b.sku) === sku &&
        b.warehouse === warehouse &&
        b.firstShippedAt !== null &&
        b.lastShippedAt !== null &&
        b.firstShippedAt <= at &&
        at <= b.lastShippedAt,
    );
    return {
      affected: shipping.filter((b) => affectedBatches.has(normCode(b.batchCode))),
      others: shipping.filter((b) => !affectedBatches.has(normCode(b.batchCode))),
    };
  };

  for (const order of input.orders) {
    for (const line of order.lines) {
      if (!line.sku || !skus.has(normSku(line.sku))) continue;
      const sku = normSku(line.sku);
      stats.linesConsidered++;
      unitPrices.add(`${order.currency}:${line.unitPriceMinor}`);
      if ((orderedFrom && order.placedAt < orderedFrom) || (orderedTo && order.placedAt > orderedTo)) {
        stats.outsideOrderWindow++;
        continue;
      }

      const { remaining, returned, replaced } = remainingQuantity(line);
      const choice = choosePayment(order, payments);
      const base = {
        orderId: order.id,
        orderLineId: line.id,
        paymentId: choice.payment?.id ?? null,
        customerEmail: order.customerEmail ?? choice.payment?.payerEmail ?? null,
        customerName: order.customerName ?? choice.payment?.payerName ?? null,
      };
      const lineEvidence: Evidence = {
        source: "order_line",
        recordId: line.id,
        fact: `Order ${order.orderNumber} (${day(order.placedAt)}) includes ${line.quantity} x ${line.sku} "${line.title}".`,
        strength: unitScoped || hasShipWindow ? "supports" : "proves",
      };

      if (remaining === 0) {
        const cancelled = order.status === "cancelled" || line.adjustments.some((a) => a.kind === "cancellation");
        candidates.push({
          ...base,
          subjectKey: `line:${line.id}:returned`,
          affectedQuantity: 0,
          classification: "product_only",
          needsConfirmation: false,
          status: "excluded",
          exclusionCode: cancelled ? "cancelled" : "returned",
          reasons: [cancelled ? "The order line was cancelled." : `All ${line.quantity} unit(s) were returned, so the customer no longer has the product.`],
          missing: [],
          recommendedAction: "none",
          evidence: [
            lineEvidence,
            ...line.adjustments.map((a): Evidence => ({
              source: "order_adjustment",
              recordId: a.id,
              fact: `${a.kind} of ${a.quantity} unit(s) on ${day(a.occurredAt)}.`,
              strength: "proves",
            })),
          ],
          facts: { paymentLinkStrength: choice.link?.strength ?? null },
        });
        continue;
      }

      // ---- classify each unit of the line ----
      const tally: UnitTally = { exact_unit: 0, strong_multi_source: 0, likely: 0, product_only: 0 };
      const evidence: Record<keyof UnitTally, Evidence[]> = { exact_unit: [], strong_multi_source: [], likely: [], product_only: [] };
      const missing: Record<keyof UnitTally, Set<string>> = {
        exact_unit: new Set(), strong_multi_source: new Set(), likely: new Set(), product_only: new Set(),
      };
      let cleared = 0;
      let fulfilledUnits = 0;

      const classifyUndocumented = (units: number, shippedAt: Date | null, warehouse: string, recordId: string | null) => {
        if (units <= 0) return;
        if (!unitScoped) {
          // The whole product is affected; only the ship window (if any) narrows it.
          if (!hasShipWindow) {
            tally.exact_unit += units;
            return;
          }
          if (!shippedAt) {
            tally.product_only += units;
            missing.product_only.add("No ship date is recorded, so the order cannot be placed inside or outside the affected period.");
            return;
          }
          if (inShipWindow(shippedAt)) {
            tally.exact_unit += units;
            evidence.exact_unit.push({ source: "fulfilment_line", recordId, fact: `Shipped ${day(shippedAt)}, inside the affected period.`, strength: "proves" });
          } else {
            cleared += units;
            stats.clearedByShipWindow += units;
          }
          return;
        }
        if (!shippedAt) {
          tally.product_only += units;
          missing.product_only.add("No batch code and no ship date are recorded for this order.");
          return;
        }
        if (affectedBatches.size > 0) {
          const stock = stockShipping(sku, warehouse, shippedAt);
          if (stock.affected.length > 0 && stock.others.length === 0) {
            tally.strong_multi_source += units;
            evidence.strong_multi_source.push(
              { source: "fulfilment_line", recordId, fact: `Shipped ${day(shippedAt)} from warehouse "${warehouse}". No batch code was recorded at packing.`, strength: "supports" },
              ...stock.affected.map((b): Evidence => ({
                source: "inventory_batch",
                recordId: b.id,
                fact: `Inventory records show batch ${b.batchCode} was the only batch of ${b.sku} shipping from "${warehouse}" on that date (${day(b.firstShippedAt!)} to ${day(b.lastShippedAt!)}).`,
                strength: "supports",
              })),
            );
            missing.strong_multi_source.add("No batch code was recorded at packing. The conclusion rests on inventory dates.");
            return;
          }
          if (stock.affected.length > 0) {
            tally.likely += units;
            evidence.likely.push(
              { source: "fulfilment_line", recordId, fact: `Shipped ${day(shippedAt)} from warehouse "${warehouse}". No batch code was recorded at packing.`, strength: "supports" },
              ...stock.others.map((b): Evidence => ({
                source: "inventory_batch",
                recordId: b.id,
                fact: `Unaffected batch ${b.batchCode} was also shipping from "${warehouse}" on that date, so the unit may be from either batch.`,
                strength: "contradicts",
              })),
            );
            missing.likely.add("Mixed stock: affected and unaffected batches were shipping together. Only the code on the product can settle it.");
            return;
          }
          if (stock.others.length > 0) {
            cleared += units;
            stats.clearedByInventory += units;
            return;
          }
        }
        // No inventory records cover that date. Fall back to the merchant's stated ship window.
        if (hasShipWindow) {
          if (inShipWindow(shippedAt)) {
            tally.likely += units;
            evidence.likely.push({
              source: "fulfilment_line",
              recordId,
              fact: `Shipped ${day(shippedAt)}, inside the period the merchant says the affected stock was shipping. A date alone does not prove the batch.`,
              strength: "weak",
            });
            missing.likely.add("No batch code and no inventory record. The only basis is the ship date.");
          } else {
            cleared += units;
            stats.clearedByShipWindow += units;
          }
          return;
        }
        tally.product_only += units;
        missing.product_only.add("No batch code was recorded, and there are no inventory or ship-window records to narrow it down.");
      };

      for (const f of line.fulfilments) {
        if (warehouses.size > 0 && !warehouses.has(f.warehouse)) {
          cleared += f.quantity;
          fulfilledUnits += f.quantity;
          continue;
        }
        fulfilledUnits += f.quantity;
        const serials = f.serials.map(normCode);
        if (affectedSerials.size > 0 && serials.length > 0) {
          const hit = serials.filter((s) => affectedSerials.has(s));
          if (hit.length > 0) {
            tally.exact_unit += hit.length;
            evidence.exact_unit.push({ source: "fulfilment_line", recordId: f.id, fact: `Serial number(s) ${hit.join(", ")} recorded at packing are on the affected list.`, strength: "proves" });
          }
          const clearSerials = serials.length - hit.length;
          cleared += clearSerials;
          stats.clearedByBatchRecord += clearSerials;
          classifyUndocumented(f.quantity - serials.length, f.shippedAt, f.warehouse, f.id);
          continue;
        }
        if (affectedBatches.size > 0 && f.batchCode) {
          if (affectedBatches.has(normCode(f.batchCode))) {
            tally.exact_unit += f.quantity;
            evidence.exact_unit.push({ source: "fulfilment_line", recordId: f.id, fact: `Batch ${f.batchCode} was recorded at packing for ${f.quantity} unit(s).`, strength: "proves" });
          } else {
            cleared += f.quantity;
            stats.clearedByBatchRecord += f.quantity;
          }
          continue;
        }
        classifyUndocumented(f.quantity, f.shippedAt, f.warehouse, f.id);
      }
      // Units with no fulfilment record at all.
      classifyUndocumented(Math.max(0, line.quantity - fulfilledUnits), null, "default", null);

      // ---- returns: cap the affected units at what the customer still has ----
      let available = remaining;
      const exclusion = paymentExclusion(choice.payment);
      for (const classification of ["exact_unit", "strong_multi_source", "likely", "product_only"] as const) {
        const units = Math.min(tally[classification], available);
        if (units <= 0) continue;
        available -= units;
        const reasons = [...choice.reasons];
        const need = [...missing[classification], ...choice.missing];
        if (returned > 0) {
          reasons.push(`${returned} of ${line.quantity} unit(s) were returned. Compensation covers the ${remaining} still with the customer.`);
          if (cleared > 0 || Object.values(tally).filter((n) => n > 0).length > 1) {
            need.push("Units in this order differ in status and one was returned. The records do not say which.");
          }
        }
        if (replaced) reasons.push("A replacement was sent for this line. The replacement unit may be from a different batch.");
        const { action, needsConfirmation } = actionFor(classification, choice);
        candidates.push({
          ...base,
          subjectKey: `line:${line.id}:${classification}`,
          affectedQuantity: units,
          classification,
          needsConfirmation: needsConfirmation || replaced || (returned > 0 && need.length > choice.missing.length + missing[classification].size),
          status: exclusion ? "excluded" : "proposed",
          exclusionCode: exclusion?.code ?? null,
          reasons: exclusion ? [exclusion.reason, ...reasons] : reasons,
          missing: need,
          recommendedAction: exclusion ? exclusion.action : replaced ? "merchant_review" : action,
          evidence: [lineEvidence, ...evidence[classification], ...choice.evidence],
          facts: { paymentLinkStrength: choice.link?.strength ?? null },
        });
      }
    }
  }

  // ---- PayPal payments with no order behind them ----
  for (const payment of input.payments) {
    if (linkedPaymentIds.has(payment.id)) continue;
    if ((orderedFrom && payment.occurredAt < orderedFrom) || (orderedTo && payment.occurredAt > orderedTo)) continue;
    const namesSku = payment.items.some((i) => i.code !== undefined && skus.has(normSku(i.code)));
    const amountFits = payment.items.length === 0 && unitPrices.has(`${payment.currency}:${payment.grossMinor}`);
    if (!namesSku && !amountFits) continue;
    const exclusion = paymentExclusion(payment);
    candidates.push({
      subjectKey: `txn:${payment.id}`,
      orderId: null,
      orderLineId: null,
      paymentId: payment.id,
      customerEmail: payment.payerEmail,
      customerName: payment.payerName,
      affectedQuantity: 1,
      classification: "transaction_only",
      needsConfirmation: true,
      status: exclusion ? "excluded" : "proposed",
      exclusionCode: exclusion?.code ?? null,
      reasons: exclusion ? [exclusion.reason] : [],
      missing: [
        "No order from the store matches this payment, so quantity, batch and ship date are all unknown.",
      ],
      recommendedAction: exclusion ? exclusion.action : "ask_customer",
      evidence: [
        namesSku
          ? { source: "payment_transaction", recordId: payment.id, fact: `PayPal's record of payment ${payment.transactionId} lists one of the affected product codes.`, strength: "supports" }
          : { source: "payment_transaction", recordId: payment.id, fact: `Payment ${payment.transactionId} has no item list. Only its amount equals the price of the affected product.`, strength: "weak" },
      ],
      facts: { paymentLinkStrength: null },
    });
  }
  return finish(candidates, stats);
}

// ---------- duplicate charges ----------

function sameItems(a: PaymentRecord, b: PaymentRecord): boolean {
  const key = (p: PaymentRecord) => p.items.map((i) => `${i.code ?? ""}|${i.name ?? ""}|${i.quantity ?? ""}|${i.unitMinor ?? ""}`).sort().join(";");
  return a.items.length > 0 && key(a) === key(b);
}

function matchDuplicateCharges(scope: Extract<IncidentScope, { type: "duplicate_charge" }>, input: MatchInput): MatchOutput {
  const stats = emptyStats();
  const candidates: CandidateDraft[] = [];
  const from = new Date(scope.from);
  const to = new Date(scope.to);
  const windowMs = scope.windowMinutes * 60_000;

  const ordersByPayment = new Map<string, OrderRecord[]>();
  for (const order of input.orders) {
    for (const link of order.paymentLinks) {
      if (link.strength !== "exact") continue;
      ordersByPayment.set(link.paymentId, [...(ordersByPayment.get(link.paymentId) ?? []), order]);
    }
  }

  const groups = new Map<string, PaymentRecord[]>();
  for (const p of input.payments) {
    if (p.occurredAt < from || p.occurredAt > to) continue;
    const payer = p.payerId ?? p.payerEmail?.toLowerCase();
    if (!payer) continue; // without a payer identity two payments cannot be called duplicates
    const key = `${payer}|${p.currency}|${p.grossMinor}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    let cluster: PaymentRecord[] = [];
    const flush = () => {
      if (cluster.length >= 2) evaluateCluster(cluster);
      cluster = [];
    };
    for (const p of group) {
      if (cluster.length > 0 && p.occurredAt.getTime() - cluster[0]!.occurredAt.getTime() > windowMs) flush();
      cluster.push(p);
    }
    flush();
  }

  function evaluateCluster(cluster: PaymentRecord[]): void {
    stats.linesConsidered += cluster.length;
    const orderOf = (p: PaymentRecord) => ordersByPayment.get(p.id)?.[0] ?? null;
    // The payment we treat as the genuine one: the earliest that has an order, else the earliest.
    const keeper = cluster.find((p) => orderOf(p) !== null) ?? cluster[0]!;
    const keeperOrder = orderOf(keeper);
    const claimedOrders = new Set<string>(keeperOrder ? [keeperOrder.id] : []);

    for (const p of cluster) {
      if (p === keeper) continue;
      const order = orderOf(p);
      if (order && !claimedOrders.has(order.id)) {
        // Its own order: the customer bought twice. Not a duplicate.
        claimedOrders.add(order.id);
        stats.legitimateRepeatPurchases++;
        continue;
      }
      const sameInvoice = p.invoiceId !== null && p.invoiceId === keeper.invoiceId;
      const sharesOrder = order !== null && keeperOrder !== null && order.id === keeperOrder.id;
      const minutes = Math.round((p.occurredAt.getTime() - keeper.occurredAt.getTime()) / 60_000);
      const evidence: Evidence[] = [
        {
          source: "payment_transaction",
          recordId: p.id,
          fact: `Payment ${p.transactionId} repeats payment ${keeper.transactionId}: same payer, same amount, ${minutes} minute(s) apart.`,
          strength: "supports",
        },
      ];
      let classification: Classification;
      const missing: string[] = [];
      if (sameInvoice || sharesOrder) {
        classification = "exact_unit";
        evidence.push({
          source: sharesOrder ? "order_payment_link" : "payment_transaction",
          recordId: p.id,
          fact: sharesOrder
            ? `Both payments are recorded against the same order (${keeperOrder!.orderNumber}). One order was paid twice.`
            : `Both payments carry the same invoice number (${p.invoiceId}).`,
          strength: "proves",
        });
      } else if (keeperOrder && sameItems(p, keeper)) {
        classification = "strong_multi_source";
        evidence.push({
          source: "order_payment_link",
          recordId: keeper.id,
          fact: `The store has one order (${keeperOrder.orderNumber}) for this customer in that period, and both payments list the same items.`,
          strength: "supports",
        });
        missing.push("The second payment carries no order or invoice number of its own.");
      } else {
        classification = "likely";
        missing.push("No order data ties these payments together. The customer may have meant to pay twice.");
      }
      const exclusion = paymentExclusion(p);
      candidates.push({
        subjectKey: `dup:${p.id}`,
        orderId: keeperOrder?.id ?? null,
        orderLineId: null,
        paymentId: p.id,
        customerEmail: p.payerEmail,
        customerName: p.payerName,
        affectedQuantity: 1,
        classification,
        needsConfirmation: classification !== "exact_unit",
        status: exclusion ? "excluded" : "proposed",
        exclusionCode: exclusion?.code ?? null,
        reasons: exclusion ? [exclusion.reason] : [],
        missing,
        recommendedAction: exclusion ? exclusion.action : classification === "exact_unit" ? "pay" : "merchant_review",
        evidence,
        facts: { paymentLinkStrength: "exact" },
      });
    }
  }
  return finish(candidates, stats);
}

// ---------- overcharges (wrong price) ----------

function matchOvercharge(scope: Extract<IncidentScope, { type: "overcharge" }>, input: MatchInput): MatchOutput {
  const stats = emptyStats();
  const candidates: CandidateDraft[] = [];
  const sku = normSku(scope.sku);
  const from = new Date(scope.from);
  const to = new Date(scope.to);
  const payments = new Map(input.payments.map((p) => [p.id, p]));

  for (const order of input.orders) {
    if (order.placedAt < from || order.placedAt > to) continue;
    for (const line of order.lines) {
      if (!line.sku || normSku(line.sku) !== sku) continue;
      stats.linesConsidered++;
      const over = line.unitPriceMinor - scope.correctUnitPriceMinor;
      if (over <= 0) continue; // charged the right price, or less
      const { remaining, returned } = remainingQuantity(line);
      if (remaining === 0) continue; // fully returned: the whole price went back already
      const choice = choosePayment(order, payments);
      const exclusion = paymentExclusion(choice.payment);
      const { action, needsConfirmation } = actionFor("exact_unit", choice);
      candidates.push({
        subjectKey: `line:${line.id}:overcharge`,
        orderId: order.id,
        orderLineId: line.id,
        paymentId: choice.payment?.id ?? null,
        customerEmail: order.customerEmail ?? choice.payment?.payerEmail ?? null,
        customerName: order.customerName ?? choice.payment?.payerName ?? null,
        affectedQuantity: remaining,
        classification: "exact_unit",
        needsConfirmation,
        status: exclusion ? "excluded" : "proposed",
        exclusionCode: exclusion?.code ?? null,
        reasons: [
          ...(exclusion ? [exclusion.reason] : []),
          ...choice.reasons,
          ...(returned > 0 ? [`${returned} unit(s) were returned and refunded in full already.`] : []),
        ],
        missing: choice.missing,
        recommendedAction: exclusion ? exclusion.action : action,
        evidence: [
          {
            source: "order_line",
            recordId: line.id,
            fact: `Order ${order.orderNumber} charged ${line.unitPriceMinor} minor units per unit of ${line.sku}. The correct price is ${scope.correctUnitPriceMinor}.`,
            strength: "proves",
          },
          ...choice.evidence,
        ],
        facts: { overchargePerUnitMinor: over, paymentLinkStrength: choice.link?.strength ?? null },
      });
    }
  }
  return finish(candidates, stats);
}

// ---------- service disruptions (pro-rata) ----------

function matchServicePeriod(scope: Extract<IncidentScope, { type: "service_period" }>, input: MatchInput): MatchOutput {
  const stats = emptyStats();
  const candidates: CandidateDraft[] = [];
  const skus = new Set(scope.skus.map(normSku));
  const outageStart = new Date(scope.outageStart).getTime();
  const outageEnd = new Date(scope.outageEnd).getTime();
  const payments = new Map(input.payments.map((p) => [p.id, p]));

  for (const order of input.orders) {
    for (const line of order.lines) {
      if (!line.sku || !skus.has(normSku(line.sku))) continue;
      stats.linesConsidered++;
      const choice = choosePayment(order, payments);
      const exclusion = paymentExclusion(choice.payment);
      const base = {
        orderId: order.id,
        orderLineId: line.id,
        paymentId: choice.payment?.id ?? null,
        customerEmail: order.customerEmail ?? choice.payment?.payerEmail ?? null,
        customerName: order.customerName ?? choice.payment?.payerName ?? null,
        affectedQuantity: line.quantity,
      };
      if (!line.serviceStart || !line.serviceEnd) {
        candidates.push({
          ...base,
          subjectKey: `line:${line.id}:service`,
          classification: "product_only",
          needsConfirmation: true,
          status: exclusion ? "excluded" : "proposed",
          exclusionCode: exclusion?.code ?? null,
          reasons: exclusion ? [exclusion.reason] : [],
          missing: ["The order does not record the period this payment covers, so the affected share cannot be worked out."],
          recommendedAction: exclusion ? exclusion.action : "merchant_review",
          evidence: [{ source: "order_line", recordId: line.id, fact: `Order ${order.orderNumber} includes ${line.sku}.`, strength: "supports" }],
          facts: { paymentLinkStrength: choice.link?.strength ?? null },
        });
        continue;
      }
      const start = line.serviceStart.getTime();
      const end = line.serviceEnd.getTime();
      const overlap = Math.min(end, outageEnd) - Math.max(start, outageStart);
      if (overlap <= 0) continue; // the paid period does not touch the outage
      const { action, needsConfirmation } = actionFor("exact_unit", choice);
      candidates.push({
        ...base,
        subjectKey: `line:${line.id}:service`,
        classification: "exact_unit",
        needsConfirmation,
        status: exclusion ? "excluded" : "proposed",
        exclusionCode: exclusion?.code ?? null,
        reasons: [...(exclusion ? [exclusion.reason] : []), ...choice.reasons],
        missing: choice.missing,
        recommendedAction: exclusion ? exclusion.action : action,
        evidence: [
          {
            source: "order_line",
            recordId: line.id,
            fact: `Order ${order.orderNumber} paid for ${line.sku} from ${day(line.serviceStart)} to ${day(line.serviceEnd)}, which overlaps the outage.`,
            strength: "proves",
          },
          ...choice.evidence,
        ],
        facts: {
          serviceSecondsAffected: Math.round(overlap / 1000),
          serviceSecondsTotal: Math.round((end - start) / 1000),
          paymentLinkStrength: choice.link?.strength ?? null,
        },
      });
    }
  }
  return finish(candidates, stats);
}
