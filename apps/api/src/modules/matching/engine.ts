// The matching engine: given what the merchant says is affected, and the
// records we hold, answer two separate questions for every purchase.
//
//   1. Payment identity: does this PayPal payment belong to this order?
//   2. Eligibility:      does the evidence show this purchase was affected?
//
// The two answers are never merged into one score. What happens next (the
// decision) is read off both with a fixed table, `decide` in types.ts.
//
// Pure functions only. No database, no clock, no AI. The same input always
// gives the same output, and every conclusion carries the records behind it,
// each marked as a fact, an inference or an assumption.
//
// Three rules shape everything here:
//   1. PayPal never knows the batch or serial of a product. Unit-level proof
//      can only come from the merchant's own packing records or from a named
//      person. `assertUnitProof` enforces this on every result.
//   2. A purchase date or a ship date does not prove which batch a customer
//      received. Dates can support a conclusion; they cannot settle it.
//   3. An identifier ties a payment to an order. Matching email, amount and
//      time is a guess, and a guess never moves money.

import {
  decide,
  UNIT_PROOF_SOURCES,
  type AliasRecord,
  type CandidateDraft,
  type Classification,
  type Decision,
  type Eligibility,
  type Evidence,
  type ExclusionCode,
  type IncidentScope,
  type InventoryBatchRecord,
  type MatchInput,
  type MatchOutput,
  type MatchStats,
  type OrderLineRecord,
  type OrderRecord,
  type PaymentIdentity,
  type PaymentLinkRecord,
  type PaymentRecord,
  type RecommendedAction,
} from "./types.ts";

export const normSku = (sku: string): string => sku.trim().toUpperCase();
/** Batch and serial codes are compared ignoring case, spaces and punctuation ("LOT 24-B" equals "lot24b"). */
export const normCode = (code: string): string => code.replace(/[^a-z0-9]/gi, "").toUpperCase();
/** Product titles are compared ignoring case and punctuation. */
export const normTitle = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const day = (d: Date): string => d.toISOString().slice(0, 10);

const ev = (
  dimension: Evidence["dimension"],
  kind: Evidence["kind"],
  source: Evidence["source"],
  recordId: string | null,
  fact: string,
  strength: Evidence["strength"],
): Evidence => ({ dimension, kind, source, recordId, fact, strength });

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

function finish(candidates: CandidateDraft[], stats: MatchStats, cleared: CandidateDraft[] = []): MatchOutput {
  for (const c of candidates) {
    if (c.status === "excluded") stats.excluded[c.exclusionCode ?? "other"] = (stats.excluded[c.exclusionCode ?? "other"] ?? 0) + 1;
    else stats.byClassification[c.classification] = (stats.byClassification[c.classification] ?? 0) + 1;
  }
  return { candidates, cleared, stats };
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

/**
 * Rule 1, as a check on the engine's own output: where an incident is about
 * particular batches or serial numbers, "proven" must rest on a packing
 * record or a named person's statement. Payment data, order dates, ship
 * dates and inventory dates can never get there.
 */
export function assertUnitProof(candidates: readonly CandidateDraft[]): void {
  for (const c of candidates) {
    if (c.eligibility !== "proven") continue;
    const proof = c.evidence.some(
      (e) => e.dimension === "eligibility" && e.strength === "proves" && UNIT_PROOF_SOURCES.includes(e.source),
    );
    if (!proof) {
      throw new Error(`Matching invariant broken: ${c.subjectKey} is marked proven without a unit-level record.`);
    }
  }
}

// ---------- question 1: which PayPal payment paid for an order ----------

type PaymentChoice = {
  payment: PaymentRecord | null;
  link: PaymentLinkRecord | null;
  identity: PaymentIdentity;
  /** Other payments that could be this order's payment. */
  rivals: PaymentRecord[];
  reasons: string[];
  missing: string[];
  evidence: Evidence[];
};

/** Stronger kinds of link win over weaker ones. Only links of the same rank can leave the answer ambiguous. */
const LINK_RANK: Record<PaymentLinkRecord["method"], number> = {
  manual: 3,
  store_reference: 2,
  invoice_id: 1,
  custom_id: 1,
  heuristic: 0,
};

export function choosePayment(order: OrderRecord, payments: Map<string, PaymentRecord>): PaymentChoice {
  const out: PaymentChoice = { payment: null, link: null, identity: "missing", rivals: [], reasons: [], missing: [], evidence: [] };
  const linked = order.paymentLinks
    .map((link) => ({ link, payment: payments.get(link.paymentId) }))
    .filter((x): x is { link: PaymentLinkRecord; payment: PaymentRecord } => x.payment !== undefined);

  if (linked.length === 0) {
    if (order.paymentMethod === "paypal" || order.paymentMethod === "unknown") {
      out.missing.push("No PayPal payment has been matched to this order.");
    } else {
      out.identity = "not_paypal";
      out.reasons.push(`The order was paid by ${order.paymentMethod}, not PayPal, so there is no PayPal payment to refund.`);
      out.evidence.push(ev("payment", "fact", "order", order.id, `The store records order ${order.orderNumber} as paid by ${order.paymentMethod}.`, "proves"));
    }
    return out;
  }

  const top = Math.max(...linked.map((x) => LINK_RANK[x.link.method]));
  const pool = linked.filter((x) => LINK_RANK[x.link.method] === top);
  const weaker = linked.filter((x) => LINK_RANK[x.link.method] < top && x.link.strength === "exact");
  const chosen = [...pool].sort(
    (a, b) => b.payment.grossMinor - a.payment.grossMinor || a.payment.transactionId.localeCompare(b.payment.transactionId),
  )[0]!;
  const ids = (xs: typeof pool) => xs.map((x) => x.payment.transactionId).join(", ");
  out.payment = chosen.payment;
  out.link = chosen.link;

  if (top === 0) {
    // Nothing but email, amount and time. A guess, however plausible.
    out.identity = "ambiguous";
    out.rivals = pool.filter((x) => x !== chosen).map((x) => x.payment);
    out.evidence.push(ev("payment", "inference", "order_payment_link", chosen.payment.id,
      `PayPal payment ${chosen.payment.transactionId} fits order ${order.orderNumber}: ${chosen.link.detail}`, "weak"));
    out.missing.push("The link between this order and the PayPal payment is a best guess and has not been confirmed.");
    return out;
  }

  const sameCurrency = pool.every((x) => x.payment.currency === order.currency);
  const sum = pool.reduce((a, x) => a + x.payment.grossMinor, 0);
  const isSplit = pool.length > 1 && sameCurrency && sum === order.totalMinor && pool.every((x) => x.payment.grossMinor < order.totalMinor);
  const sharedWith = chosen.link.rivalOrders ?? 0;

  if (pool.length > 1 && !isSplit) {
    out.identity = "ambiguous";
    out.rivals = pool.filter((x) => x !== chosen).map((x) => x.payment);
    out.missing.push(
      `${pool.length} PayPal payments (${ids(pool)}) carry this order's reference. Only one of them can be the payment for this order, and the records do not say which.`,
    );
  } else if (sharedWith > 0) {
    out.identity = "ambiguous";
    out.missing.push(
      `PayPal payment ${chosen.payment.transactionId} is tied to ${sharedWith + 1} orders by the same kind of reference. Which order it paid for has not been settled.`,
    );
  } else {
    out.identity = "verified";
  }

  if (chosen.link.method === "manual") {
    out.evidence.push(ev("payment", "fact", "order_payment_link", chosen.payment.id,
      `A member of staff settled that PayPal payment ${chosen.payment.transactionId} paid for order ${order.orderNumber}: ${chosen.link.detail}`,
      out.identity === "verified" ? "proves" : "supports"));
  } else {
    out.evidence.push(ev("payment", "fact", "order_payment_link", chosen.payment.id,
      `PayPal payment ${chosen.payment.transactionId} is tied to order ${order.orderNumber}: ${chosen.link.detail}`,
      out.identity === "verified" ? "proves" : "supports"));
  }
  for (const rival of out.rivals) {
    out.evidence.push(ev("payment", "fact", "payment_transaction", rival.id,
      `PayPal payment ${rival.transactionId} carries the same reference.`, "contradicts"));
  }
  if (isSplit) {
    out.reasons.push(`The order has ${pool.length} PayPal payments that add up to the order total. The largest (${chosen.payment.transactionId}) is used.`);
    out.evidence.push(ev("payment", "assumption", "order_payment_link", chosen.payment.id,
      "The order was paid in parts. Refunding the largest part first is our choice, not something the records say.", "weak"));
  }
  if (weaker.length > 0) {
    out.reasons.push(
      `Another PayPal payment (${ids(weaker)}) also carries this order's number. It was not used, because a stronger record names ${chosen.payment.transactionId}. It may be a double charge.`,
    );
    for (const x of weaker) {
      out.evidence.push(ev("state", "fact", "payment_transaction", x.payment.id,
        `PayPal payment ${x.payment.transactionId} carries this order's number as well.`, "weak"));
    }
  }
  if (out.identity === "verified") {
    if (chosen.payment.currency !== order.currency) {
      out.evidence.push(ev("payment", "fact", "payment_transaction", chosen.payment.id,
        `The payment is in ${chosen.payment.currency} but the order is in ${order.currency}.`, "contradicts"));
    } else if (!isSplit && chosen.payment.grossMinor < order.totalMinor) {
      out.evidence.push(ev("state", "fact", "payment_transaction", chosen.payment.id,
        "The PayPal payment is smaller than the order total, so part of the order was paid another way. A refund cannot exceed the PayPal payment.", "supports"));
    }
  }
  return out;
}

/** Exclusions that come from the state of the payment itself. */
function paymentExclusion(payment: PaymentRecord | null): { code: ExclusionCode; reason: string; action: RecommendedAction; evidence: Evidence } | null {
  if (!payment) return null;
  if (payment.disputeState === "open") {
    const reason = `A PayPal dispute is open on payment ${payment.transactionId}. Refunding outside the dispute could pay the customer twice.`;
    return { code: "dispute_open", reason, action: "resolve_dispute", evidence: ev("state", "fact", "payment_transaction", payment.id, reason, "proves") };
  }
  if (payment.refundedMinor >= payment.grossMinor) {
    const reason = `Payment ${payment.transactionId} has already been refunded in full.`;
    return { code: "already_refunded", reason, action: "none", evidence: ev("state", "fact", "payment_transaction", payment.id, reason, "proves") };
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

/** The next step a person should take, in the older vocabulary the screens and reports already use. */
function actionFor(classification: Classification, identity: PaymentIdentity): RecommendedAction {
  if (classification === "strong_multi_source") return "merchant_review";
  if (classification !== "exact_unit") return "ask_customer";
  if (identity === "not_paypal") return "pay_outside_paypal";
  return identity === "verified" ? "pay" : "confirm_payment_link";
}

/** True when a record still needs a person before it can enter a batch. */
const needsPerson = (decision: Decision): boolean => decision !== "ready_for_approval" && decision !== "pay_outside_paypal";

/** Applies a payment-state exclusion on top of the decision the two answers give. */
function withExclusion(base: Decision, exclusion: { code: ExclusionCode } | null): Decision {
  if (!exclusion) return base;
  return exclusion.code === "dispute_open" ? "on_hold" : "excluded";
}

// ---------- product incidents (defects, recalls, cancelled events) ----------

type UnitTally = Record<"exact_unit" | "strong_multi_source" | "likely" | "product_only", number>;

const ELIGIBILITY_OF: Record<keyof UnitTally, Eligibility> = {
  exact_unit: "proven",
  strong_multi_source: "supported",
  likely: "uncertain",
  product_only: "unknown",
};

type Resolved = { sku: string; alias: AliasRecord | null };

/** Which catalogue SKU an order line is, by its own code or by an alias a person confirmed. */
function skuResolver(scopeSkus: Set<string>, aliases: readonly AliasRecord[]): (line: OrderLineRecord) => Resolved | null {
  const bySku = new Map<string, AliasRecord>();
  const byTitle = new Map<string, AliasRecord>();
  for (const a of aliases) {
    if (!scopeSkus.has(normSku(a.canonicalSku))) continue;
    if (a.kind === "sku") bySku.set(normSku(a.alias), a);
    else byTitle.set(normTitle(a.alias), a);
  }
  return (line) => {
    if (line.sku && line.sku.trim() !== "") {
      const sku = normSku(line.sku);
      if (scopeSkus.has(sku)) return { sku, alias: null };
      const alias = bySku.get(sku);
      return alias ? { sku: normSku(alias.canonicalSku), alias } : null;
    }
    const alias = byTitle.get(normTitle(line.title));
    return alias ? { sku: normSku(alias.canonicalSku), alias } : null;
  };
}

function matchProduct(scope: Extract<IncidentScope, { type: "product" }>, input: MatchInput): MatchOutput {
  const stats = emptyStats();
  const candidates: CandidateDraft[] = [];
  const clearedDrafts: CandidateDraft[] = [];
  const skus = new Set(scope.skus.map(normSku));
  const resolve = skuResolver(skus, input.aliases ?? []);
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
      const resolved = resolve(line);
      if (!resolved) continue;
      const sku = resolved.sku;
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
      const baseFacts = {
        paymentLinkStrength: choice.link?.strength ?? null,
        ...(choice.rivals.length > 0 ? { rivalPayments: choice.rivals.map((r) => r.transactionId) } : {}),
        ...(resolved.alias ? { matchedAlias: resolved.alias.alias } : {}),
      };
      const shown = line.sku && line.sku.trim() !== "" ? line.sku : "(no product code)";
      const lineEvidence: Evidence[] = [
        ev("eligibility", "fact", "order_line", line.id,
          `Order ${order.orderNumber} (${day(order.placedAt)}) includes ${line.quantity} x ${shown} "${line.title}".`,
          unitScoped || hasShipWindow ? "supports" : "proves"),
      ];
      if (resolved.alias) {
        lineEvidence.push(ev("eligibility", "inference", "product_alias", resolved.alias.id,
          `"${resolved.alias.alias}" on this order is treated as ${resolved.alias.canonicalSku}. ${resolved.alias.confirmedBy ? `${resolved.alias.confirmedBy} confirmed this.` : "A member of staff confirmed this."}`,
          "supports"));
      }

      if (remaining === 0) {
        const cancelled = order.status === "cancelled" || line.adjustments.some((a) => a.kind === "cancellation");
        candidates.push({
          ...base,
          subjectKey: `line:${line.id}:returned`,
          affectedQuantity: 0,
          paymentIdentity: choice.identity,
          eligibility: "unknown",
          decision: "excluded",
          classification: "product_only",
          needsConfirmation: false,
          status: "excluded",
          exclusionCode: cancelled ? "cancelled" : "returned",
          reasons: [cancelled ? "The order line was cancelled." : `All ${line.quantity} unit(s) were returned, so the customer no longer has the product.`],
          missing: [],
          recommendedAction: "none",
          evidence: [
            ...lineEvidence,
            ...line.adjustments.map((a) =>
              ev("state", "fact", "order_adjustment", a.id, `${a.kind} of ${a.quantity} unit(s) on ${day(a.occurredAt)}.`, "proves")),
          ],
          facts: baseFacts,
        });
        continue;
      }

      // ---- question 2, unit by unit ----
      const tally: UnitTally = { exact_unit: 0, strong_multi_source: 0, likely: 0, product_only: 0 };
      const evidence: Record<keyof UnitTally, Evidence[]> = { exact_unit: [], strong_multi_source: [], likely: [], product_only: [] };
      const missing: Record<keyof UnitTally, Set<string>> = {
        exact_unit: new Set(), strong_multi_source: new Set(), likely: new Set(), product_only: new Set(),
      };
      let cleared = 0;
      let fulfilledUnits = 0;
      const clearedEvidence: Evidence[] = [];
      const clearedFacts: Pick<CandidateDraft["facts"], "clearedBy"> = {};
      const clear = (units: number, by: NonNullable<CandidateDraft["facts"]["clearedBy"]>, proof: Evidence) => {
        if (units <= 0) return;
        cleared += units;
        clearedFacts.clearedBy ??= by;
        clearedEvidence.push(proof);
      };

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
            evidence.exact_unit.push(ev("eligibility", "fact", "fulfilment_line", recordId, `Shipped ${day(shippedAt)}, inside the affected period.`, "proves"));
          } else {
            stats.clearedByShipWindow += units;
            clear(units, "ship_window", ev("eligibility", "fact", "fulfilment_line", recordId, `Shipped ${day(shippedAt)}, outside the affected period.`, "proves"));
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
              ev("eligibility", "fact", "fulfilment_line", recordId, `Shipped ${day(shippedAt)} from warehouse "${warehouse}". No batch code was recorded at packing.`, "supports"),
              ...stock.affected.map((b) =>
                ev("eligibility", "inference", "inventory_batch", b.id,
                  `Inventory records show batch ${b.batchCode} was the only batch of ${b.sku} shipping from "${warehouse}" on that date (${day(b.firstShippedAt!)} to ${day(b.lastShippedAt!)}).`,
                  "supports")),
            );
            missing.strong_multi_source.add("No batch code was recorded at packing. The conclusion rests on inventory dates.");
            return;
          }
          if (stock.affected.length > 0) {
            tally.likely += units;
            evidence.likely.push(
              ev("eligibility", "fact", "fulfilment_line", recordId, `Shipped ${day(shippedAt)} from warehouse "${warehouse}". No batch code was recorded at packing.`, "supports"),
              ...stock.others.map((b) =>
                ev("eligibility", "inference", "inventory_batch", b.id,
                  `Unaffected batch ${b.batchCode} was also shipping from "${warehouse}" on that date, so the unit may be from either batch.`,
                  "contradicts")),
            );
            missing.likely.add("Mixed stock: affected and unaffected batches were shipping together. Only the code on the product can settle it.");
            return;
          }
          if (stock.others.length > 0) {
            stats.clearedByInventory += units;
            clear(units, "inventory_dates", ev("eligibility", "inference", "inventory_batch", stock.others[0]!.id,
              `Inventory records show only unaffected stock (${stock.others.map((b) => b.batchCode).join(", ")}) shipping from "${warehouse}" on ${day(shippedAt)}. No batch code was recorded at packing.`,
              "supports"));
            return;
          }
        }
        // No inventory records cover that date. Fall back to the merchant's stated ship window.
        if (hasShipWindow) {
          if (inShipWindow(shippedAt)) {
            tally.likely += units;
            evidence.likely.push(ev("eligibility", "assumption", "fulfilment_line", recordId,
              `Shipped ${day(shippedAt)}, inside the period the merchant says the affected stock was shipping. A date alone does not prove the batch.`,
              "weak"));
            missing.likely.add("No batch code and no inventory record. The only basis is the ship date.");
          } else {
            stats.clearedByShipWindow += units;
            clear(units, "ship_window", ev("eligibility", "assumption", "incident_scope", null,
              `Shipped ${day(shippedAt)}, outside the period the merchant says the affected stock was shipping. That period is the merchant's statement, not a record.`,
              "weak"));
          }
          return;
        }
        tally.product_only += units;
        missing.product_only.add("No batch code was recorded, and there are no inventory or ship-window records to narrow it down.");
      };

      for (const f of line.fulfilments) {
        if (warehouses.size > 0 && !warehouses.has(f.warehouse)) {
          fulfilledUnits += f.quantity;
          clear(f.quantity, "warehouse", ev("eligibility", "fact", "fulfilment_line", f.id,
            `Shipped from warehouse "${f.warehouse}", which is not one of the affected warehouses.`, "proves"));
          continue;
        }
        fulfilledUnits += f.quantity;
        const serials = f.serials.map(normCode);
        if (affectedSerials.size > 0 && serials.length > 0) {
          const hit = serials.filter((s) => affectedSerials.has(s));
          if (hit.length > 0) {
            tally.exact_unit += hit.length;
            evidence.exact_unit.push(ev("eligibility", "fact", "fulfilment_line", f.id, `Serial number(s) ${hit.join(", ")} recorded at packing are on the affected list.`, "proves"));
          }
          const clearSerials = serials.length - hit.length;
          stats.clearedByBatchRecord += clearSerials;
          clear(clearSerials, "serial_record", ev("eligibility", "fact", "fulfilment_line", f.id,
            `${clearSerials} serial number(s) recorded at packing are not on the affected list.`, "proves"));
          classifyUndocumented(f.quantity - serials.length, f.shippedAt, f.warehouse, f.id);
          continue;
        }
        if (affectedBatches.size > 0 && f.batchCode) {
          if (affectedBatches.has(normCode(f.batchCode))) {
            tally.exact_unit += f.quantity;
            evidence.exact_unit.push(ev("eligibility", "fact", "fulfilment_line", f.id, `Batch ${f.batchCode} was recorded at packing for ${f.quantity} unit(s).`, "proves"));
          } else {
            stats.clearedByBatchRecord += f.quantity;
            clear(f.quantity, "batch_record", ev("eligibility", "fact", "fulfilment_line", f.id,
              `Batch ${f.batchCode} was recorded at packing for ${f.quantity} unit(s). It is not an affected batch.`, "proves"));
          }
          continue;
        }
        classifyUndocumented(f.quantity, f.shippedAt, f.warehouse, f.id);
      }
      // Units with no fulfilment record at all.
      classifyUndocumented(Math.max(0, line.quantity - fulfilledUnits), null, "default", null);

      if (cleared > 0) {
        clearedDrafts.push({
          ...base,
          subjectKey: `line:${line.id}:cleared`,
          affectedQuantity: cleared,
          paymentIdentity: choice.identity,
          eligibility: "not_affected",
          decision: "not_affected",
          classification: "product_only",
          needsConfirmation: false,
          status: "cleared",
          exclusionCode: null,
          reasons: [`${cleared} of ${line.quantity} unit(s) are shown by the records not to be affected.`],
          missing: [],
          recommendedAction: "none",
          evidence: [...lineEvidence, ...clearedEvidence],
          facts: { ...baseFacts, ...clearedFacts },
        });
      }

      // ---- returns: cap the affected units at what the customer still has ----
      let available = remaining;
      const exclusion = paymentExclusion(choice.payment);
      const kinds = Object.values(tally).filter((n) => n > 0).length;
      for (const classification of ["exact_unit", "strong_multi_source", "likely", "product_only"] as const) {
        const units = Math.min(tally[classification], available);
        if (units <= 0) continue;
        available -= units;
        const reasons = [...choice.reasons];
        const need = [...missing[classification], ...choice.missing];
        const unitEvidence = [...evidence[classification]];
        let unitDoubt = false;
        if (returned > 0) {
          reasons.push(`${returned} of ${line.quantity} unit(s) were returned. Compensation covers the ${remaining} still with the customer.`);
          if (cleared > 0 || kinds > 1) {
            need.push("Units in this order differ in status and one was returned. The records do not say which.");
            unitDoubt = true;
          }
        }
        if (replaced) {
          reasons.push("A replacement was sent for this line. The replacement unit may be from a different batch.");
          const swap = line.adjustments.find((a) => a.kind === "replacement");
          unitEvidence.push(ev("eligibility", "fact", "order_adjustment", swap?.id ?? null,
            "A replacement was sent for this line. No record says which batch the replacement came from.", "contradicts"));
          unitDoubt = true;
        }
        // A later change to the order means the unit the customer holds today may not be the one first packed.
        let eligibility = ELIGIBILITY_OF[classification];
        if (unitDoubt && eligibility === "proven") eligibility = "uncertain";
        const baseDecision = decide(choice.identity, eligibility);
        candidates.push({
          ...base,
          subjectKey: `line:${line.id}:${classification}`,
          affectedQuantity: units,
          paymentIdentity: choice.identity,
          eligibility,
          decision: withExclusion(baseDecision, exclusion),
          classification,
          needsConfirmation: needsPerson(baseDecision),
          status: exclusion ? "excluded" : "proposed",
          exclusionCode: exclusion?.code ?? null,
          reasons: exclusion ? [exclusion.reason, ...reasons] : reasons,
          missing: need,
          recommendedAction: exclusion ? exclusion.action : replaced ? "merchant_review" : actionFor(classification, choice.identity),
          evidence: [...lineEvidence, ...unitEvidence, ...choice.evidence, ...(exclusion ? [exclusion.evidence] : [])],
          facts: baseFacts,
        });
      }
    }
  }

  // ---- PayPal payments with no order behind them ----
  // PayPal's own data can show that somebody paid for the product. It can
  // never show which batch they received, so these stay "unknown".
  for (const payment of input.payments) {
    if (linkedPaymentIds.has(payment.id)) continue;
    if ((orderedFrom && payment.occurredAt < orderedFrom) || (orderedTo && payment.occurredAt > orderedTo)) continue;
    const namesSku = payment.items.some((i) => i.code !== undefined && skus.has(normSku(i.code)));
    const amountFits = payment.items.length === 0 && unitPrices.has(`${payment.currency}:${payment.grossMinor}`);
    if (!namesSku && !amountFits) continue;
    const exclusion = paymentExclusion(payment);
    const baseDecision = decide("missing", "unknown");
    candidates.push({
      subjectKey: `txn:${payment.id}`,
      orderId: null,
      orderLineId: null,
      paymentId: payment.id,
      customerEmail: payment.payerEmail,
      customerName: payment.payerName,
      affectedQuantity: 1,
      paymentIdentity: "missing",
      eligibility: "unknown",
      decision: withExclusion(baseDecision, exclusion),
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
          ? ev("eligibility", "inference", "payment_transaction", payment.id, `PayPal's record of payment ${payment.transactionId} lists one of the affected product codes.`, "supports")
          : ev("eligibility", "inference", "payment_transaction", payment.id, `Payment ${payment.transactionId} has no item list. Only its amount equals the price of the affected product.`, "weak"),
        ev("payment", "fact", "payment_transaction", payment.id, "No order in the store's records carries this payment's ID or invoice number.", "contradicts"),
        ...(exclusion ? [exclusion.evidence] : []),
      ],
      facts: { paymentLinkStrength: null },
    });
  }
  if (unitScoped) assertUnitProof(candidates);
  return finish(candidates, stats, clearedDrafts);
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
        ev("eligibility", "inference", "payment_transaction", p.id,
          `Payment ${p.transactionId} repeats payment ${keeper.transactionId}: same payer, same amount, ${minutes} minute(s) apart.`, "supports"),
      ];
      let classification: Classification;
      // Here the payment under question is the one to refund. It is identified
      // when an order or invoice number ties it to the first payment.
      let identity: PaymentIdentity;
      const missing: string[] = [];
      if (sameInvoice || sharesOrder) {
        classification = "exact_unit";
        identity = "verified";
        evidence.push(ev("eligibility", "fact", sharesOrder ? "order_payment_link" : "payment_transaction", p.id,
          sharesOrder
            ? `Both payments are recorded against the same order (${keeperOrder!.orderNumber}). One order was paid twice.`
            : `Both payments carry the same invoice number (${p.invoiceId}).`,
          "proves"));
      } else if (keeperOrder && sameItems(p, keeper)) {
        classification = "strong_multi_source";
        identity = "missing";
        evidence.push(ev("eligibility", "inference", "order_payment_link", keeper.id,
          `The store has one order (${keeperOrder.orderNumber}) for this customer in that period, and both payments list the same items.`,
          "supports"));
        missing.push("The second payment carries no order or invoice number of its own.");
      } else {
        classification = "likely";
        identity = "missing";
        missing.push("No order data ties these payments together. The customer may have meant to pay twice.");
      }
      const eligibility: Eligibility = classification === "exact_unit" ? "proven" : classification === "strong_multi_source" ? "supported" : "uncertain";
      const exclusion = paymentExclusion(p);
      const baseDecision = decide(identity, eligibility);
      candidates.push({
        subjectKey: `dup:${p.id}`,
        orderId: keeperOrder?.id ?? null,
        orderLineId: null,
        paymentId: p.id,
        customerEmail: p.payerEmail,
        customerName: p.payerName,
        affectedQuantity: 1,
        paymentIdentity: identity,
        eligibility,
        decision: withExclusion(baseDecision, exclusion),
        classification,
        needsConfirmation: classification !== "exact_unit",
        status: exclusion ? "excluded" : "proposed",
        exclusionCode: exclusion?.code ?? null,
        reasons: exclusion ? [exclusion.reason] : [],
        missing,
        recommendedAction: exclusion ? exclusion.action : classification === "exact_unit" ? "pay" : "merchant_review",
        evidence: exclusion ? [...evidence, exclusion.evidence] : evidence,
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
      const baseDecision = decide(choice.identity, "proven");
      candidates.push({
        subjectKey: `line:${line.id}:overcharge`,
        orderId: order.id,
        orderLineId: line.id,
        paymentId: choice.payment?.id ?? null,
        customerEmail: order.customerEmail ?? choice.payment?.payerEmail ?? null,
        customerName: order.customerName ?? choice.payment?.payerName ?? null,
        affectedQuantity: remaining,
        paymentIdentity: choice.identity,
        eligibility: "proven",
        decision: withExclusion(baseDecision, exclusion),
        classification: "exact_unit",
        needsConfirmation: needsPerson(baseDecision),
        status: exclusion ? "excluded" : "proposed",
        exclusionCode: exclusion?.code ?? null,
        reasons: [
          ...(exclusion ? [exclusion.reason] : []),
          ...choice.reasons,
          ...(returned > 0 ? [`${returned} unit(s) were returned and refunded in full already.`] : []),
        ],
        missing: choice.missing,
        recommendedAction: exclusion ? exclusion.action : actionFor("exact_unit", choice.identity),
        evidence: [
          ev("eligibility", "fact", "order_line", line.id,
            `Order ${order.orderNumber} charged ${line.unitPriceMinor} minor units per unit of ${line.sku}. The correct price is ${scope.correctUnitPriceMinor}.`,
            "proves"),
          ...choice.evidence,
          ...(exclusion ? [exclusion.evidence] : []),
        ],
        facts: {
          overchargePerUnitMinor: over,
          paymentLinkStrength: choice.link?.strength ?? null,
          ...(choice.rivals.length > 0 ? { rivalPayments: choice.rivals.map((r) => r.transactionId) } : {}),
        },
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
        paymentIdentity: choice.identity,
      };
      const linkFacts = {
        paymentLinkStrength: choice.link?.strength ?? null,
        ...(choice.rivals.length > 0 ? { rivalPayments: choice.rivals.map((r) => r.transactionId) } : {}),
      };
      if (!line.serviceStart || !line.serviceEnd) {
        candidates.push({
          ...base,
          subjectKey: `line:${line.id}:service`,
          eligibility: "unknown",
          decision: withExclusion(decide(choice.identity, "unknown"), exclusion),
          classification: "product_only",
          needsConfirmation: true,
          status: exclusion ? "excluded" : "proposed",
          exclusionCode: exclusion?.code ?? null,
          reasons: exclusion ? [exclusion.reason] : [],
          missing: ["The order does not record the period this payment covers, so the affected share cannot be worked out."],
          recommendedAction: exclusion ? exclusion.action : "merchant_review",
          evidence: [
            ev("eligibility", "fact", "order_line", line.id, `Order ${order.orderNumber} includes ${line.sku}.`, "supports"),
            ...choice.evidence,
            ...(exclusion ? [exclusion.evidence] : []),
          ],
          facts: linkFacts,
        });
        continue;
      }
      const start = line.serviceStart.getTime();
      const end = line.serviceEnd.getTime();
      const overlap = Math.min(end, outageEnd) - Math.max(start, outageStart);
      if (overlap <= 0) continue; // the paid period does not touch the outage
      const baseDecision = decide(choice.identity, "proven");
      candidates.push({
        ...base,
        subjectKey: `line:${line.id}:service`,
        eligibility: "proven",
        decision: withExclusion(baseDecision, exclusion),
        classification: "exact_unit",
        needsConfirmation: needsPerson(baseDecision),
        status: exclusion ? "excluded" : "proposed",
        exclusionCode: exclusion?.code ?? null,
        reasons: [...(exclusion ? [exclusion.reason] : []), ...choice.reasons],
        missing: choice.missing,
        recommendedAction: exclusion ? exclusion.action : actionFor("exact_unit", choice.identity),
        evidence: [
          ev("eligibility", "fact", "order_line", line.id,
            `Order ${order.orderNumber} paid for ${line.sku} from ${day(line.serviceStart)} to ${day(line.serviceEnd)}, which overlaps the outage.`,
            "proves"),
          ...choice.evidence,
          ...(exclusion ? [exclusion.evidence] : []),
        ],
        facts: {
          serviceSecondsAffected: Math.round(overlap / 1000),
          serviceSecondsTotal: Math.round((end - start) / 1000),
          ...linkFacts,
        },
      });
    }
  }
  return finish(candidates, stats);
}
