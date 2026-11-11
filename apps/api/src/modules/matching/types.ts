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
  method: "store_reference" | "invoice_id" | "custom_id" | "heuristic" | "manual";
  strength: "exact" | "heuristic";
  detail: string;
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

/**
 * How well the records establish that this customer is affected. Ordered from
 * strongest to weakest. These are categories with stated grounds, not
 * probabilities: we have no validated model that could justify a percentage.
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
  | "order_line"
  | "fulfilment_line"
  | "inventory_batch"
  | "payment_transaction"
  | "order_payment_link"
  | "order_adjustment"
  | "customer_statement"
  | "claim_evidence"
  | "reviewer";

export type Evidence = {
  source: EvidenceSource;
  recordId: string | null;
  fact: string;
  /** proves: settles the question. supports: adds weight. weak: suggestive only. contradicts: points the other way. */
  strength: "proves" | "supports" | "weak" | "contradicts";
};

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
  classification: Classification;
  needsConfirmation: boolean;
  status: "proposed" | "excluded";
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
};

export type MatchOutput = { candidates: CandidateDraft[]; stats: MatchStats };
