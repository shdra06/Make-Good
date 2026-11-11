// The compensation engine: how much one affected customer is owed, and how
// the money can reach them.
//
// Pure and deterministic. It returns the amount together with the working,
// step by step, and the records each step used, so a merchant can see exactly
// why a customer is owed a particular sum. Nothing here is decided by AI.

import { createHash } from "node:crypto";
import { z } from "zod";
import { ValidationError } from "../../platform/errors.ts";
import { allocate, clampMinor, formatMoney, portionBps, portionRatio } from "../../platform/money.ts";
import type { CandidateDraft, OrderLineRecord, OrderRecord, PaymentRecord } from "../matching/types.ts";

export const CompensationRule = z
  .object({
    type: z.enum([
      "full_refund", // the affected units, in full
      "percent", // a share of the affected units
      "fixed_per_unit", // a set amount for each affected unit
      "fixed_per_customer", // a set amount once
      "pro_rata", // the share of a paid service period that was lost
      "overcharge_difference", // what was charged above the correct price
      "duplicate_payment", // the whole of a payment that was taken twice
    ]),
    /** For "percent": 10000 is 100%. */
    percentBps: z.number().int().min(1).max(10000).optional(),
    /** For the fixed types. */
    fixedMinor: z.number().int().positive().optional(),
    fixedCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
    includeTax: z.boolean().default(true),
    includeShipping: z.boolean().default(false),
    minMinor: z.number().int().min(0).nullable().default(null),
    maxMinor: z.number().int().min(0).nullable().default(null),
    rounding: z.enum(["half_up", "half_even", "down", "up"]).default("half_up"),
    /** Send a separate PayPal payout when a refund to the original payment is not possible. */
    allowPayout: z.boolean().default(false),
    /** PayPal refunds an original payment for up to 180 days. */
    refundWindowDays: z.number().int().min(1).max(180).default(180),
  })
  .superRefine((rule, ctx) => {
    if (rule.type === "percent" && rule.percentBps === undefined) {
      ctx.addIssue({ code: "custom", message: "A percentage rule needs percentBps.", path: ["percentBps"] });
    }
    if ((rule.type === "fixed_per_unit" || rule.type === "fixed_per_customer") && (rule.fixedMinor === undefined || !rule.fixedCurrency)) {
      ctx.addIssue({ code: "custom", message: "A fixed-amount rule needs fixedMinor and fixedCurrency.", path: ["fixedMinor"] });
    }
    if (rule.minMinor !== null && rule.maxMinor !== null && rule.minMinor > rule.maxMinor) {
      ctx.addIssue({ code: "custom", message: "The minimum cannot be above the maximum.", path: ["minMinor"] });
    }
  });
export type CompensationRule = z.infer<typeof CompensationRule>;

export type Route = "refund_original" | "payout" | "manual" | "none";

export type CalculationStep = {
  label: string;
  /** The running or component amount this step produced, when it has one. */
  amountMinor: number | null;
  detail: string;
  source?: { table: string; id: string };
};

export type CompensationResult = {
  currency: string;
  /** What the rule says the customer is owed, before looking at what can still be refunded. */
  entitlementMinor: number;
  /** Already given back on this line by the store. */
  alreadyRefundedMinor: number;
  /** What will actually be paid now. */
  payableMinor: number;
  route: Route;
  routeReason: string;
  /** For payouts: who receives it. */
  recipient: { type: "PAYPAL_ID" | "EMAIL"; value: string } | null;
  steps: CalculationStep[];
  inputsHash: string;
};

export type CompensationInput = {
  rule: CompensationRule;
  now: Date;
  candidate: Pick<CandidateDraft, "affectedQuantity" | "classification" | "facts" | "customerEmail">;
  order: OrderRecord | null;
  line: OrderLineRecord | null;
  payment: PaymentRecord | null;
  /** Whether the connected PayPal account can send payouts at all. */
  payoutsAvailable: boolean;
};

type LineValue = { netMinor: number; taxMinor: number; shippingMinor: number; steps: CalculationStep[] };

/**
 * The value of one order line after spreading order-level discount, tax and
 * shipping across the lines. Every split uses the largest-remainder method,
 * so the lines always add back up to the order exactly.
 */
export function lineValue(order: OrderRecord, line: OrderLineRecord, rule: Pick<CompensationRule, "includeTax" | "includeShipping">): LineValue {
  const steps: CalculationStep[] = [];
  const cur = order.currency;
  const index = order.lines.findIndex((l) => l.id === line.id);
  if (index === -1) throw new ValidationError("The order line does not belong to the order.");

  const gross = order.lines.map((l) => l.unitPriceMinor * l.quantity);
  const afterLineDiscount = order.lines.map((l, i) => gross[i]! - l.discountMinor);
  steps.push({
    label: "Line price",
    amountMinor: gross[index]!,
    detail: `${line.quantity} x ${formatMoney(line.unitPriceMinor, cur)}`,
    source: { table: "order_lines", id: line.id },
  });
  if (line.discountMinor > 0) {
    steps.push({ label: "Line discount", amountMinor: -line.discountMinor, detail: "Discount recorded on this line.", source: { table: "order_lines", id: line.id } });
  }

  // Order-level discount that is not already on a line is spread by line value.
  const lineDiscounts = order.lines.reduce((a, l) => a + l.discountMinor, 0);
  const orderLevelDiscount = Math.max(0, order.discountMinor - lineDiscounts);
  const discountShares = allocate(orderLevelDiscount, afterLineDiscount);
  const net = afterLineDiscount.map((v, i) => Math.max(0, v - discountShares[i]!));
  if (orderLevelDiscount > 0) {
    steps.push({
      label: "Share of order discount",
      amountMinor: -discountShares[index]!,
      detail: `Order discount ${formatMoney(orderLevelDiscount, cur)} spread across ${order.lines.length} line(s) by value.`,
      source: { table: "orders", id: order.id },
    });
  }

  let tax = 0;
  if (rule.includeTax) {
    const lineTaxTotal = order.lines.reduce((a, l) => a + l.taxMinor, 0);
    if (lineTaxTotal > 0) {
      tax = line.taxMinor;
      steps.push({ label: "Tax on this line", amountMinor: tax, detail: "Tax recorded on the line.", source: { table: "order_lines", id: line.id } });
    } else if (order.taxMinor > 0) {
      tax = allocate(order.taxMinor, net)[index]!;
      steps.push({
        label: "Share of order tax",
        amountMinor: tax,
        detail: `Order tax ${formatMoney(order.taxMinor, cur)} spread across lines by value.`,
        source: { table: "orders", id: order.id },
      });
    }
  }

  let shipping = 0;
  if (rule.includeShipping && order.shippingMinor > 0) {
    // Shipping is carried by physical goods only.
    const weights = order.lines.map((l, i) => (l.kind === "physical" ? net[i]! : 0));
    shipping = allocate(order.shippingMinor, weights)[index]!;
    steps.push({
      label: "Share of shipping",
      amountMinor: shipping,
      detail: `Shipping ${formatMoney(order.shippingMinor, cur)} spread across physical lines by value.`,
      source: { table: "orders", id: order.id },
    });
  }
  return { netMinor: net[index]!, taxMinor: tax, shippingMinor: shipping, steps };
}

function hashInputs(input: CompensationInput): string {
  const { rule, candidate, order, line, payment } = input;
  const material = {
    rule,
    candidate: { q: candidate.affectedQuantity, f: candidate.facts },
    order: order && {
      id: order.id, c: order.currency, d: order.discountMinor, s: order.shippingMinor, t: order.taxMinor,
      lines: order.lines.map((l) => [l.id, l.quantity, l.unitPriceMinor, l.discountMinor, l.taxMinor, l.kind]),
    },
    line: line && { id: line.id, adj: line.adjustments.map((a) => [a.kind, a.quantity, a.amountMinor]) },
    payment: payment && {
      id: payment.id, c: payment.currency, g: payment.grossMinor, r: payment.refundedMinor,
      at: payment.occurredAt.toISOString(), d: payment.disputeState,
    },
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function calculateCompensation(input: CompensationInput): CompensationResult {
  const { rule, candidate, order, line, payment, now } = input;
  const steps: CalculationStep[] = [];
  const currency = payment?.currency ?? order?.currency ?? rule.fixedCurrency;
  if (!currency) throw new ValidationError("Cannot work out a currency: there is no payment, no order and no fixed amount.");
  const inputsHash = hashInputs(input);
  const money = (minor: number) => formatMoney(minor, currency);
  const done = (
    entitlement: number,
    already: number,
    payable: number,
    route: Route,
    routeReason: string,
    recipient: CompensationResult["recipient"] = null,
  ): CompensationResult => ({
    currency, entitlementMinor: entitlement, alreadyRefundedMinor: already, payableMinor: payable,
    route, routeReason, recipient, steps, inputsHash,
  });
  const manual = (reason: string) => {
    steps.push({ label: "Needs a person", amountMinor: null, detail: reason });
    return done(0, 0, 0, "manual", reason);
  };

  // ---------- 1. What the rule says is owed ----------
  let entitlement = 0;
  /** The most that can be given back on this line without exceeding what was paid for it. */
  let lineCeiling: number | null = null;
  const qty = candidate.affectedQuantity;
  const needsLine = rule.type === "full_refund" || rule.type === "percent" || rule.type === "pro_rata" || rule.type === "overcharge_difference";

  if (needsLine) {
    if (!order || !line) {
      return manual("There is no order line for this customer, so a price-based rule cannot be applied. Use a fixed amount or review by hand.");
    }
    if (order.currency !== currency) {
      return manual(`The order is in ${order.currency} and the payment in ${currency}. Amounts in different currencies are not combined automatically.`);
    }
    if (line.unitPriceMinor === 0 && line.parentLineId) {
      return manual("This is a component of a bundle with no price of its own. Its share of the bundle price is not recorded.");
    }
    const value = lineValue(order, line, rule);
    steps.push(...value.steps);
    const lineTotal = value.netMinor + value.taxMinor + value.shippingMinor;
    steps.push({ label: "Line value", amountMinor: lineTotal, detail: "Price less discounts, plus the tax and shipping this rule includes." });
    const share = qty === line.quantity ? lineTotal : portionRatio(lineTotal, qty, line.quantity, rule.rounding);
    if (qty !== line.quantity) {
      steps.push({ label: "Affected units", amountMinor: share, detail: `${qty} of ${line.quantity} unit(s) are affected.` });
    }
    lineCeiling = share;

    if (rule.type === "full_refund") {
      entitlement = share;
    } else if (rule.type === "percent") {
      entitlement = portionBps(share, rule.percentBps!, rule.rounding);
      steps.push({ label: "Percentage", amountMinor: entitlement, detail: `${rule.percentBps! / 100}% of ${money(share)}.` });
    } else if (rule.type === "pro_rata") {
      const affected = candidate.facts.serviceSecondsAffected;
      const total = candidate.facts.serviceSecondsTotal;
      if (!affected || !total) return manual("The paid service period is not recorded, so the lost share cannot be worked out.");
      entitlement = portionRatio(share, affected, total, rule.rounding);
      steps.push({
        label: "Share of the period lost",
        amountMinor: entitlement,
        detail: `${(affected / 3600).toFixed(1)} of ${(total / 3600).toFixed(1)} hours paid for were lost.`,
      });
    } else {
      const over = candidate.facts.overchargePerUnitMinor;
      if (!over || over <= 0) return manual("No overcharge is recorded for this line.");
      const overTotal = over * qty;
      steps.length = 0; // the line-value steps do not apply to an overcharge; start again
      steps.push({ label: "Overcharge", amountMinor: overTotal, detail: `${qty} x ${money(over)} charged above the correct price.`, source: { table: "order_lines", id: line.id } });
      let taxPart = 0;
      const gross = line.unitPriceMinor * line.quantity;
      if (rule.includeTax && line.taxMinor > 0 && gross > 0) {
        taxPart = portionRatio(line.taxMinor, overTotal, gross, rule.rounding);
        steps.push({ label: "Tax on the overcharge", amountMinor: taxPart, detail: "The same share of the line tax as the overcharge is of the line price." });
      }
      entitlement = overTotal + taxPart;
      lineCeiling = null; // capped by the payment below
    }
  } else if (rule.type === "fixed_per_unit" || rule.type === "fixed_per_customer") {
    if (rule.fixedCurrency !== currency) {
      return manual(`The rule pays in ${rule.fixedCurrency} but the customer paid in ${currency}. A refund must be in the currency of the original payment.`);
    }
    entitlement = rule.type === "fixed_per_unit" ? rule.fixedMinor! * qty : rule.fixedMinor!;
    steps.push({
      label: "Fixed amount",
      amountMinor: entitlement,
      detail: rule.type === "fixed_per_unit" ? `${qty} unit(s) x ${money(rule.fixedMinor!)}.` : "One fixed amount per customer.",
    });
  } else {
    if (!payment) return manual("A duplicate-payment rule needs the duplicate payment.");
    entitlement = payment.grossMinor;
    steps.push({ label: "Duplicate payment", amountMinor: entitlement, detail: `The whole of payment ${payment.transactionId}.`, source: { table: "payment_transactions", id: payment.id } });
  }

  // ---------- 2. Limits set by the merchant ----------
  const limited = entitlement > 0 ? clampMinor(entitlement, rule.minMinor, rule.maxMinor) : 0;
  if (limited !== entitlement) {
    steps.push({
      label: limited > entitlement ? "Raised to the minimum" : "Capped at the maximum",
      amountMinor: limited,
      detail: `The rule sets ${limited > entitlement ? `a minimum of ${money(rule.minMinor!)}` : `a maximum of ${money(rule.maxMinor!)}`}.`,
    });
    entitlement = limited;
  }

  // ---------- 3. What has already been given back ----------
  const already = line ? line.adjustments.filter((a) => a.kind === "store_refund").reduce((a, r) => a + r.amountMinor, 0) : 0;
  let payable = entitlement;
  if (already > 0 && lineCeiling !== null) {
    const room = Math.max(0, lineCeiling - already);
    if (payable > room) {
      payable = room;
      steps.push({
        label: "Less earlier refunds on this line",
        amountMinor: payable,
        detail: `${money(already)} was already refunded on this line. The total given back cannot exceed what was paid for it.`,
        source: line ? { table: "order_lines", id: line.id } : undefined,
      });
    }
  }

  // ---------- 4. What the payment can still give back ----------
  if (payment) {
    const refundable = payment.grossMinor - payment.refundedMinor;
    if (payable > refundable) {
      steps.push({
        label: "Limited by the payment",
        amountMinor: Math.max(0, refundable),
        detail: `Payment ${payment.transactionId} was ${money(payment.grossMinor)} and ${money(payment.refundedMinor)} is already refunded, so ${money(Math.max(0, refundable))} is left.`,
        source: { table: "payment_transactions", id: payment.id },
      });
      payable = Math.max(0, refundable);
    }
  }

  steps.push({ label: "To pay", amountMinor: payable, detail: payable === entitlement ? "The full amount owed." : `${money(entitlement)} owed, ${money(payable)} can be paid.` });

  if (payable === 0) {
    return done(entitlement, already, 0, "none", entitlement === 0 ? "Nothing is owed under this rule." : "Nothing is left to pay: it was already refunded.");
  }

  // ---------- 5. How the money can reach the customer ----------
  const payoutRecipient = (): CompensationResult["recipient"] => {
    if (payment?.payerId) return { type: "PAYPAL_ID", value: payment.payerId };
    const email = payment?.payerEmail ?? candidate.customerEmail;
    return email ? { type: "EMAIL", value: email } : null;
  };
  const viaPayout = (why: string): CompensationResult => {
    const recipient = payoutRecipient();
    if (!rule.allowPayout) return done(entitlement, already, payable, "manual", `${why} The rule does not allow separate payouts, so this needs a person.`);
    if (!input.payoutsAvailable) return done(entitlement, already, payable, "manual", `${why} The connected PayPal account cannot send payouts.`);
    if (!recipient) return done(entitlement, already, payable, "manual", `${why} There is no PayPal account or email to send a payout to.`);
    return done(entitlement, already, payable, "payout", `${why} Sent as a separate PayPal payout.`, recipient);
  };

  if (!payment) return viaPayout("There is no PayPal payment to refund.");
  if (payment.disputeState === "open") {
    return done(entitlement, already, payable, "manual", "A PayPal dispute is open on this payment. Resolve it in PayPal first.");
  }
  const ageDays = (now.getTime() - payment.occurredAt.getTime()) / 86_400_000;
  if (ageDays > rule.refundWindowDays) {
    return viaPayout(`The payment is ${Math.floor(ageDays)} days old. PayPal refunds an original payment for ${rule.refundWindowDays} days.`);
  }
  return done(entitlement, already, payable, "refund_original", "Refund to the original PayPal payment, in its own currency.");
}
