// Response shapes of the incident API, as the web app reads them.
// Money is in minor units; a map is keyed by currency code.

export type MoneyMap = Record<string, number>;
export type PaymentIdentity = "verified" | "ambiguous" | "missing" | "not_paypal";
export type Eligibility = "proven" | "supported" | "uncertain" | "unknown" | "not_affected";

export type Scope = { type: string; skus: string[]; batchCodes?: string[] };
export type Compensation =
  { type: "full_refund" } | { type: "percent"; percentBps: number } | { type: "fixed_per_unit"; fixedMinor: number; fixedCurrency: string };

export type RecoveryMap = {
  incident: { id: string; title: string; description: string };
  rule: { version: number; scope: Scope; compensationInWords: string; created_at: string } | null;
  lastMatch: { finished_at: string; stats: { linesConsidered: number } } | null;
  matrix: Array<{ paymentIdentity: PaymentIdentity; eligibility: Eligibility; count: number; amount: MoneyMap }>;
  groups: Array<{ disposition: string; group: string; label: string; why: string; count: number; amount: MoneyMap; paid: MoneyMap }>;
  dataLabels: { paypal: string; paypalMeaning?: string; merchantRecords: string };
};

export type Quoted<T> = T & { quote: string };
export type ExtractionOutput = {
  products: Array<Quoted<{ code: string; included: boolean; inCatalogue: boolean }>>;
  batchCodes: Array<Quoted<{ code: string; affected: boolean }>>;
  remedy: Array<Quoted<{ kind: string }>>;
  dates: Array<Quoted<{ from: string; to: string; meaning: string }>>;
  dropped: Array<{ field: string; value: string; why: string }>;
  warnings: string[];
  proposedScope: { skus: string[]; batchCodes: string[] } | null;
};

export type EvidenceResponse = {
  documents: Array<{ id: string; title: string; body: string; data_label: string }>;
  extractions: Array<{ id: string; status: string; method: string; model: string | null; output: ExtractionOutput; decided_by: string | null }>;
  ai: { configured: boolean; model: string | null };
};

export type CandidateRow = {
  id: string;
  status: string;
  disposition: string;
  payment_identity: PaymentIdentity;
  eligibility: Eligibility;
  order_number: string | null;
  customer_name: string | null;
  customer_email: string | null;
  line_title: string | null;
  sku: string | null;
  affected_quantity: number;
  decided_by: string | null;
  payment_state: string | null;
  payment_amount_minor: number | null;
  payable_minor: number | null;
  currency: string;
};

export type EvidenceItem = { id?: string; dimension: "payment" | "eligibility" | "state"; kind: string; source: string; strength: string; fact: string };

export type Operation = {
  id: string;
  state: string;
  kind: string;
  amount_minor: number;
  currency: string;
  order_number: string | null;
  customer_name: string | null;
  provider_refund_id: string | null;
  attempts: number;
  failure_code: string | null;
  failure_message: string | null;
  idempotency_key: string;
  manifest_version: number | null;
};

export type CandidateDetail = {
  candidate: {
    id: string;
    status: string;
    disposition: string;
    decision: string;
    payment_identity: PaymentIdentity;
    eligibility: Eligibility;
    customer_name: string | null;
    customer_email: string | null;
    missing: string[] | null;
    decided_by_name: string | null;
    decided_at: string | null;
    decision_basis: string | null;
    decision_note: string | null;
  };
  order: { order_number: string; placed_at: string; payment_reference: string | null } | null;
  payment: { transaction_id: string; gross_minor: number; refunded_minor: number; currency: string; dispute_state: string | null } | null;
  evidence: EvidenceItem[];
  calculation: {
    currency: string;
    route_reason: string;
    steps: { steps: Array<{ label: string; detail: string; amountMinor: number | null }> };
  } | null;
  operations: Operation[];
  paymentOptions: Array<{
    id: string;
    transaction_id: string;
    gross_minor: number;
    currency: string;
    occurred_at: string;
    payer_name: string | null;
    detail: string;
    other_orders: number;
  }> | null;
};

export type Explanation = { model: string; explanation: { summary: string; points: Array<{ text: string; cites: string[] }> } };

export type AliasSuggestion = {
  id: string;
  alias: string;
  canonicalSku: string;
  status: "suggested" | "confirmed" | "rejected";
  reason: string;
  sampleTitles: string[];
  lines: number;
  batchCodes: string[];
  decidedBy: string | null;
  ai: { model: string; verdict: string; reason: string; quotedTitle: string } | null;
};
export type AliasResponse = { aliases: AliasSuggestion[]; aiNote?: string | null };

export type MatchResult = { disputes?: { checked: number; open: number; failed?: string | null } };

export type HeldItem = {
  orderNumber: string | null;
  customerName: string | null;
  customerEmail: string | null;
  why: string;
  wouldPayMinor: number | null;
  currency: string | null;
};

export type Policy = {
  key: string;
  label: string;
  payNow: { customers: number; amount: MoneyMap };
  ofWhichUnproven: { customers: number; amount: MoneyMap };
  askedToConfirm: number | null;
  additionalIfAllConfirm: { amount: MoneyMap };
  notPaid: { customers: number };
  blockedUntilPaymentReconciled: { customers: number; amount: MoneyMap };
  outsidePayPalOrManual: { customers: number };
  tradeOff: string;
  againstKnownAnswers: { unitsPaidThatWereNotAffected: number; affectedUnitsNotPaidNow: number } | null;
};
export type PolicyComparison = { currentRule: { inWords: string }; policies: Policy[] };

export type Preview = { totals: { count: number; byCurrency: Record<string, { amountMinor: number }> }; held: HeldItem[] };

export type ManifestItem = {
  n: number;
  orderNumber: string;
  customerName: string;
  paymentIdentity: PaymentIdentity;
  eligibility: Eligibility;
  confirmedBy: string | null;
  confirmationBasis: string | null;
  captureId: string | null;
  recipient: string | null;
  amountMinor: number;
  currency: string;
};
export type Manifest = {
  version: number;
  contentHash: string;
  content: {
    items: ManifestItem[];
    notIncluded: HeldItem[];
    createdAt: string;
    createdBy: { name: string };
    rule: { version: number };
    environment: string;
  };
};

export type BatchResponse = {
  batch: { id: string; status: string; paused_reason: string | null };
  operations: Operation[];
  manifests: Array<{
    version: number;
    status: string;
    content_hash: string;
    item_count: number;
    created_at: string;
    created_by: string | null;
    invalidated_reason: Array<{ detail: string }> | null;
  }>;
  approvals: Array<{ decision: string; name: string; manifest_hash: string; manifest_version: number | null; created_at: string; comment: string | null }>;
};

export type IncidentDetail = {
  incident: { id: string; kind: string; title: string; description: string; status: string };
  batches: Array<{ id: string; status: string }>;
};

export type Evaluation =
  | { available: false }
  | {
      available: true;
      basis: string;
      cases: Array<{ orderNumber: string; note: string; truthAffectedUnits: number; owedMinor: number }>;
      eligibility: {
        correct: number;
        truthAffectedUnits: number;
        wrongInclusions: number;
        heldAffected: number;
        heldNotAffected: number;
        missed: number;
        precision: number | null;
      };
      payment: { falseMatches: number; verifiedAndRight: number; held: number };
      money: { linesPaid: number; overpaidLines: number; underpaidLines: number; paidToUnaffected: number };
      duplicates: { paymentsRefundedTwiceInThisIncident: number };
    };

export type AuditResponse = {
  chain: { ok: boolean; rows: number };
  rows: Array<{ id?: string; created_at: string; actor_name: string | null; actor_kind: string; action: string }>;
};

export type Reconciliation = Array<{ batch_id: string; status: string; kind: string; resolution: string | null }>;

export type Notices = {
  transport: string | null;
  items: Array<{
    id: string;
    kind: string;
    to_email: string;
    subject: string;
    body: string;
    delivery_ref: string | null;
    created_at: string;
    order_number: string | null;
  }>;
};

export type CsvResult = {
  rows: number;
  orders: number;
  errors: Array<{ row: number; message: string }>;
  imported: boolean;
  created: number;
  updated: number;
  warnings: string[];
  links: { exact: number; heuristic: number };
};

export type TimelineDeadline = "open" | "closing_soon" | "closed" | "no_paypal_payment";
export type TimelineBatch = {
  id: string;
  sku: string;
  batchCode: string;
  warehouse: string;
  quantity: number | null;
  receivedAt: string | null;
  firstShippedAt: string | null;
  lastShippedAt: string | null;
  affected: boolean;
};
export type TimelineRecord = {
  candidateId: string;
  orderNumber: string | null;
  customerName: string | null;
  sku: string | null;
  quantity: number;
  placedAt: string | null;
  shippedAt: string | null;
  warehouse: string | null;
  recordedBatches: string[];
  paymentIdentity: PaymentIdentity;
  eligibility: Eligibility;
  disposition: string;
  dispositionLabel: string;
  paidAt: string | null;
  refundDeadline: string | null;
  daysLeft: number | null;
  deadline: TimelineDeadline;
};
export type RecallTimeline = {
  incident: { id: string; title: string };
  labels: { merchantRecords: "synthetic" | "merchant" };
  refundWindowDays: number;
  closingSoonDays: number;
  scope: { skus: string[]; batchCodes: string[]; shippedFrom: string | null; shippedTo: string | null } | null;
  batches: TimelineBatch[];
  mixedStock: Array<{ sku: string; warehouse: string; from: string; to: string; affectedBatch: string; otherBatch: string }>;
  records: TimelineRecord[];
  summary: {
    records: number;
    shippedInMixedStock: number;
    windowOpen: number;
    closingSoon: number;
    closed: number;
    noPaypalPayment: number;
    owedAfterWindowClosed: number;
    owedClosingSoon: number;
  } | null;
};
