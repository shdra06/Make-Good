// Domain records the matching and compensation engines work on. These are
// plain data: the engines never touch the database, which keeps every rule
// testable on its own.

import { z } from "zod";

// ---------- what the merchant's systems and PayPal told us ----------

export type FulfilmentLineRecord = {
  id: string;
  fulfilmentId: string;
  quantity: number;
  shippedAt: Date | null;
  warehouse: string;
  /** Present only if the warehouse recorded which batch was packed. */
  batchCode: string | null;
  /** Present only if serial numbers were scanned at packing. */
  serials: string[];
};

export type AdjustmentRecord = {
  id: string;
  kind: "return" | "replacement" | "store_refund" | "cancellation";
  quantity: number;
  amountMinor: number;
  occurredAt: Date;
};

export type OrderLineRecord = {
  id: string;
  sku: string | null;
  variantId: string | null;
  title: string;
  kind: "physical" | "digital" | "subscription" | "ticket" | "service";
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxMinor: number;
  parentLineId: string | null;
  serviceStart: Date | null;
  serviceEnd: Date | null;
  fulfilments: FulfilmentLineRecord[];
  adjustments: AdjustmentRecord[];
};

export type PaymentLinkRecord = {
  paymentId: string;
  /**
   * How the order and the payment were tied together, strongest first:
   *   manual           a named member of staff said this payment paid this order
   *   store_reference  the store recorded PayPal's own payment ID on the order
   *   invoice_id       the payment carries the order number as its invoice ID
   *   custom_id        the payment carries the order's ID as its custom ID
   *   heuristic        same email, amount and time; no identifier in common
   */
  method: "store_reference" | "invoice_id" | "custom_id" | "heuristic" | "manual";
  strength: "exact" | "heuristic";
  detail: string;
  /** Other orders tied to the same payment by a link at least as strong as this one. */
  rivalOrders?: number;
};

/** A product code or title on an order that a person confirmed means a catalogue SKU. */
export type AliasRecord = {
  id: string;
  kind: "sku" | "title";
  alias: string;
  canonicalSku: string;
  /** Who confirmed it, for the evidence trail. */
  confirmedBy: string | null;
};

export type OrderRecord = {
  id: string;
  orderNumber: string;
  channel: string;
  placedAt: Date;
  currency: string;
  customerEmail: string | null;
  customerName: string | null;
  isGuest: boolean;
  paymentMethod: "paypal" | "card" | "cash" | "bank" | "other" | "unknown";
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  status: string;
  lines: OrderLineRecord[];
  /** Order-level adjustments that are not tied to one line. */
  adjustments: AdjustmentRecord[];
  paymentLinks: PaymentLinkRecord[];
};

export type PaymentRecord = {
  id: string;
  /** PayPal's ID. For checkout payments this is the capture ID. */
  transactionId: string;
  occurredAt: Date;
  currency: string;
  grossMinor: number;
  refundedMinor: number;
  payerId: string | null;
  payerEmail: string | null;
  payerName: string | null;
  payerCountry: string | null;
  invoiceId: string | null;
  customId: string | null;
  items: Array<{ code?: string; name?: string; quantity?: number; unitMinor?: number }>;
  disputeState: "open" | "resolved" | null;
};

export type InventoryBatchRecord = {
  id: string;
  variantId: string;
  sku: string;
  batchCode: string;
  warehouse: string;
  receivedAt: Date | null;
  firstShippedAt: Date | null;
  lastShippedAt: Date | null;
};

// ---------- what the merchant says is affected (the incident scope) ----------

const isoDate = z.iso.datetime({ offset: true });

export const ProductScope = z.object({
  type: z.literal("product"),
  /** Exact SKUs. A different variant has a different SKU and is never matched. */
  skus: z.array(z.string().min(1)).min(1).max(200),
  /** Affected batch codes. Empty means every unit of these SKUs in the date windows. */
  batchCodes: z.array(z.string().min(1)).max(200).default([]),
  serials: z.array(z.string().min(1)).max(5000).default([]),
  orderedFrom: isoDate.nullable().default(null),
  orderedTo: isoDate.nullable().default(null),
  /** When the merchant believes the affected stock was shipping. A single-source statement. */
  shippedFrom: isoDate.nullable().default(null),
  shippedTo: isoDate.nullable().default(null),
  warehouses: z.array(z.string().min(1)).max(50).default([]),
});

export const DuplicateChargeScope = z.object({
  type: z.literal("duplicate_charge"),
  from: isoDate,
  to: isoDate,
  /** Two payments from one payer for one amount within this many minutes are compared. */
  windowMinutes: z.number().int().min(1).max(1440).default(10),
});

export const OverchargeScope = z.object({
  type: z.literal("overcharge"),
  sku: z.string().min(1),
  correctUnitPriceMinor: z.number().int().min(0),
  from: isoDate,
  to: isoDate,
});

export const ServicePeriodScope = z.object({
  type: z.literal("service_period"),
  skus: z.array(z.string().min(1)).min(1).max(200),
  outageStart: isoDate,
  outageEnd: isoDate,
});

export const IncidentScope = z.discriminatedUnion("type", [
  ProductScope,
  DuplicateChargeScope,
  OverchargeScope,
  ServicePeriodScope,
]);
export type IncidentScope = z.infer<typeof IncidentScope>;

// ---------- what the engine concludes ----------
//
// Two separate questions are answered for every record, and never merged
// into one score:
//
//   1. Payment identity: does this PayPal payment belong to this order?
//   2. Eligibility:      does the evidence show this purchase was affected?
//
// A third value, the decision, is read off those two with a fixed table.
// All three are categories with stated grounds. None is a probability: we
// have no validated model that could justify a percentage.

/** Question 1. Is the PayPal payment we would refund really the payment for this order? */
export type PaymentIdentity =
  | "verified" // one payment, tied to this order by an identifier both systems carry, or by a named person
  | "ambiguous" // a payment fits, but another payment or another order fits as well, or only email/amount/time agree
  | "missing" // the order should have a PayPal payment and none has been found (or a payment has no order)
  | "not_paypal"; // the order was paid another way, so there is nothing at PayPal to refund

/** Question 2. Was this purchase affected by the incident? */
export type Eligibility =
  | "proven" // a record names the unit, batch, order line or payment itself
  | "supported" // no unit-level record, but independent merchant records agree (an inference)
  | "uncertain" // consistent with being affected, but mixed stock, a single source, or a later change to the order
  | "unknown" // right product, nothing about batch or date
  | "not_affected"; // the records show it was not affected

/** What should happen next. A fixed function of the two answers above and of the payment's state. */
export type Decision =
  | "ready_for_approval" // verified payment, proven eligibility: may go into a batch for a person to approve
  | "needs_eligibility_evidence" // verified payment, eligibility not proven: ask the customer or check records
  | "reconcile_payment" // proven eligibility, payment not settled: a person must say which payment
  | "investigate" // neither is settled: no automatic path to payment
  | "pay_outside_paypal" // affected, but not paid through PayPal
  | "on_hold" // a PayPal dispute is open on the payment
  | "excluded" // returned, cancelled or already refunded in full
  | "not_affected";

/** The fixed table. Kept here so the engine, the tests and the screens all use the same one. */
export function decide(identity: PaymentIdentity, eligibility: Eligibility): Decision {
  if (eligibility === "not_affected") return "not_affected";
  if (eligibility === "proven") {
    if (identity === "verified") return "ready_for_approval";
    if (identity === "not_paypal") return "pay_outside_paypal";
    return "reconcile_payment";
  }
  return identity === "verified" || identity === "not_paypal" ? "needs_eligibility_evidence" : "investigate";
}

/**
 * The older single ladder. It is still stored because it names the grounds
 * for eligibility in more detail, and older reports read it. It never drives
 * a payment on its own.
 */
export type Classification =
  | "exact_unit" // a record names the unit, batch, order or payment itself
  | "strong_multi_source" // no unit-level record, but independent merchant records agree
  | "likely" // consistent with being affected, but mixed stock or a single source
  | "product_only" // right product, nothing about batch or date
  | "transaction_only" // only a payment that fits; no order data
  | "claim_verified"; // came from a customer claim that a reviewer accepted

export const CLASSIFICATION_ORDER: readonly Classification[] = [
  "exact_unit",
  "strong_multi_source",
  "likely",
  "product_only",
  "transaction_only",
  "claim_verified",
];

export type EvidenceSource =
  | "order"
  | "order_line"
  | "fulfilment_line"
  | "inventory_batch"
  | "payment_transaction"
  | "order_payment_link"
  | "order_adjustment"
  | "customer_statement"
  | "claim_evidence"
  | "reviewer"
  | "product_alias"
  | "incident_scope";

/** Which of the two questions a piece of evidence speaks to. "state" is about the payment or order as it stands now. */
export type EvidenceDimension = "payment" | "eligibility" | "state";

/**
 * fact        a stored record says so (a packing record, PayPal's payment ID on an order)
 * inference   worked out from records that do not say it directly (inventory dates, same email and amount)
 * assumption  taken as true without a record (the merchant's stated ship window, "the largest payment is the one")
 */
export type EvidenceKind = "fact" | "inference" | "assumption";

export type Evidence = {
  source: EvidenceSource;
  recordId: string | null;
  fact: string;
  /** proves: settles the question. supports: adds weight. weak: suggestive only. contradicts: points the other way. */
  strength: "proves" | "supports" | "weak" | "contradicts";
  dimension: EvidenceDimension;
  kind: EvidenceKind;
};

/** Sources that can prove which unit or batch a customer received. PayPal's payment data is never one of them. */
export const UNIT_PROOF_SOURCES: readonly EvidenceSource[] = ["fulfilment_line", "customer_statement", "claim_evidence", "reviewer"];

export type RecommendedAction =
  | "pay" // nothing more needed
  | "merchant_review" // a person at the merchant should confirm before paying
  | "ask_customer" // only the customer can settle it (for example by reading the batch code)
  | "confirm_payment_link" // affected, but which payment to refund is not certain
  | "pay_outside_paypal" // affected, but there is no PayPal payment to refund
  | "resolve_dispute" // PayPal dispute open on the payment
  | "none"; // excluded

export type ExclusionCode =
  | "returned" // the customer no longer has the unit
  | "cancelled"
  | "already_refunded" // the payment has nothing left to refund
  | "dispute_open";

export type CandidateDraft = {
  /** Stable across re-runs, so a re-match updates rather than duplicates. */
  subjectKey: string;
  orderId: string | null;
  orderLineId: string | null;
  paymentId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  affectedQuantity: number;
  /** Question 1 and question 2, answered separately. */
  paymentIdentity: PaymentIdentity;
  eligibility: Eligibility;
  decision: Decision;
  classification: Classification;
  needsConfirmation: boolean;
  /** "cleared": the records show the purchase was not affected. Kept so the reason can be shown. */
  status: "proposed" | "excluded" | "cleared";
  exclusionCode: ExclusionCode | null;
  reasons: string[];
  missing: string[];
  recommendedAction: RecommendedAction;
  evidence: Evidence[];
  /** Facts the compensation engine needs, computed once here. */
  facts: {
    overchargePerUnitMinor?: number;
    /** Seconds of the paid service period that fall inside the outage, and the whole period. */
    serviceSecondsAffected?: number;
    serviceSecondsTotal?: number;
    paymentLinkStrength?: "exact" | "heuristic" | null;
    /** PayPal payment IDs that could also be this order's payment. Present when the identity is ambiguous. */
    rivalPayments?: string[];
    /** For cleared records: what showed the purchase was not affected. */
    clearedBy?: "batch_record" | "serial_record" | "inventory_dates" | "ship_window" | "warehouse";
    /** The product code as written on the order, when it reached the incident through a confirmed alias. */
    matchedAlias?: string;
  };
};

export type MatchStats = {
  linesConsidered: number;
  outsideOrderWindow: number;
  clearedByBatchRecord: number;
  clearedByInventory: number;
  clearedByShipWindow: number;
  legitimateRepeatPurchases: number;
  byClassification: Record<string, number>;
  excluded: Record<string, number>;
};

export type MatchInput = {
  scope: IncidentScope;
  now: Date;
  orders: OrderRecord[];
  payments: PaymentRecord[];
  batches: InventoryBatchRecord[];
  /** Confirmed aliases only. A suggested alias changes nothing until a person confirms it. */
  aliases?: AliasRecord[];
};

export type MatchOutput = {
  /** Affected, held and excluded records. */
  candidates: CandidateDraft[];
  /** Buyers of the product whose records show they were not affected. */
  cleared: CandidateDraft[];
  stats: MatchStats;
};
