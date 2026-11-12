// Words for the values the API sends. Nothing here decides anything.

import type { Compensation, Eligibility, Operation, PaymentIdentity } from "./types";

export type Tone = "neutral" | "ok" | "hold" | "stop" | "info";

export const PAYMENT: Record<PaymentIdentity, { label: string; tone: Tone; meaning: string }> = {
  verified: {
    label: "Payment verified",
    tone: "ok",
    meaning: "One PayPal payment is tied to this order by an identifier both systems carry, or by a named person.",
  },
  ambiguous: {
    label: "Payment ambiguous",
    tone: "hold",
    meaning: "A payment fits, but another payment or order fits too, or only email, amount and time agree.",
  },
  missing: {
    label: "Payment not found",
    tone: "hold",
    meaning: "The order should have a PayPal payment and none has been matched, or a payment has no order.",
  },
  not_paypal: { label: "Not paid by PayPal", tone: "neutral", meaning: "The order was paid another way. There is nothing at PayPal to refund." },
};

export const UNIT: Record<Eligibility, { label: string; tone: Tone; meaning: string }> = {
  proven: { label: "Unit proven", tone: "ok", meaning: "A record names the unit or batch itself." },
  supported: { label: "Supported by records", tone: "hold", meaning: "No unit-level record, but the merchant's own records agree. An inference." },
  uncertain: { label: "Uncertain", tone: "hold", meaning: "Consistent with being affected, but mixed stock, a single source, or a later change to the order." },
  unknown: { label: "Unknown", tone: "hold", meaning: "The right product. Nothing about batch or date." },
  not_affected: { label: "Not affected", tone: "neutral", meaning: "The records show this purchase was not affected." },
};

/** What a cell of the two-answer table means for the next step. */
export function cellAction(identity: PaymentIdentity, unit: Eligibility): { label: string; tone: Tone } {
  if (unit === "proven") {
    if (identity === "verified") return { label: "Ready for approval", tone: "ok" };
    if (identity === "not_paypal") return { label: "Owed outside PayPal", tone: "hold" };
    return { label: "Reconcile the payment", tone: "hold" };
  }
  if (identity === "verified" || identity === "not_paypal") return { label: "Needs evidence of the unit", tone: "hold" };
  return { label: "Investigate", tone: "hold" };
}

export const KIND: Record<string, { label: string; tone: Tone }> = {
  fact: { label: "Fact", tone: "ok" },
  inference: { label: "Inference", tone: "info" },
  assumption: { label: "Assumption", tone: "hold" },
};

export const STRENGTH: Record<string, string> = {
  proves: "settles it",
  supports: "adds weight",
  weak: "suggestive only",
  contradicts: "points the other way",
};

export const SOURCE: Record<string, string> = {
  order: "order",
  order_line: "order line",
  fulfilment_line: "packing record",
  inventory_batch: "stock record",
  payment_transaction: "PayPal payment",
  order_payment_link: "order ↔ payment",
  order_adjustment: "return or refund",
  customer_statement: "customer",
  claim_evidence: "claim",
  reviewer: "member of staff",
  product_alias: "product-code alias",
  incident_scope: "incident rules",
};

export const HELD_WHY: Record<string, string> = {
  waiting_for_confirmation: "Waiting for a person's decision",
  payment_not_reconciled: "The payment is not settled",
  eligibility_not_confirmed: "The unit is not proven and nobody has confirmed it",
  paid_under_another_incident: "Already paid under another incident",
  payment_in_another_batch: "Another payment list is refunding the same PayPal payment",
  second_refund_on_same_payment: "One refund per PayPal payment per list; this goes on the next",
  payout_needs_its_own_approval: "A payout needs a payment list and approval of its own",
  refund_goes_in_a_refund_batch: "A refund goes on a refund list",
  needs_manual_handling: "Cannot be refunded to the original payment automatically",
  nothing_to_pay: "Nothing left to pay",
  already_in_a_batch_or_paid: "Already on a list, or paid",
  excluded: "Excluded: returned, already refunded, or in a dispute",
  declined: "Declined by a person",
};

const OP_STATE: Record<string, { label: string; tone: Tone }> = {
  planned: { label: "Not sent", tone: "neutral" },
  queued: { label: "Queued", tone: "info" },
  submitting: { label: "Sent, awaiting reply", tone: "info" },
  pending_provider: { label: "Pending at PayPal", tone: "info" },
  unknown: { label: "Outcome unknown: asking PayPal", tone: "hold" },
  succeeded: { label: "Paid: confirmed by PayPal", tone: "ok" },
  failed_retryable: { label: "Failed, can be retried", tone: "stop" },
  failed_final: { label: "Failed", tone: "stop" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function opLabel(o: Pick<Operation, "state" | "failure_code">): { label: string; tone: Tone } {
  if (o.state === "cancelled" && o.failure_code === "APPROVAL_NO_LONGER_COVERS") return { label: "Withheld: approval no longer covered it", tone: "stop" };
  return OP_STATE[o.state] ?? { label: o.state, tone: "neutral" };
}

export const LIVE_OP_STATES = ["queued", "submitting", "unknown", "pending_provider"];

export const BASIS: Array<[string, string]> = [
  ["customer_confirmed_unit", "The customer confirmed the code on their unit"],
  ["merchant_records_checked", "We checked records outside this system"],
  ["policy_include_unproven", "We choose to pay without proof of the unit"],
];

export const RULES: Record<string, { label: string; rule: Compensation }> = {
  full_refund: { label: "Full refund of the affected units", rule: { type: "full_refund" } },
  half: { label: "Half the price of the affected units", rule: { type: "percent", percentBps: 5000 } },
  fixed: { label: "20.00 USD for each affected unit", rule: { type: "fixed_per_unit", fixedMinor: 2000, fixedCurrency: "USD" } },
};

export const DEFAULT_POLICIES = [
  { key: "proven_only", label: "Pay only customers whose unit is proven", include: ["proven"], askTheRest: false },
  { key: "ask_the_rest", label: "Pay proven units now, and ask the others to confirm their batch code", include: ["proven"], askTheRest: true },
  {
    key: "include_likely",
    label: "Also pay customers who are likely affected, after you review them",
    include: ["proven", "supported", "uncertain"],
    askTheRest: false,
  },
];

export const BATCH_STARTED = ["executing", "paused", "completed", "completed_with_failures", "cancelled"];
export const BATCH_APPROVED = ["approved", "executing", "paused", "completed", "completed_with_failures"];
export const BATCH_DONE = ["completed", "completed_with_failures"];
