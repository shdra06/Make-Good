// The contract between Make Good and PayPal. The rest of the system talks to
// this interface only.
//
// Three implementations exist:
//   PayPalRestClient      the real PayPal REST API (sandbox by default)
//   SimulatedPayPal       an in-memory model for automated tests and for local
//                         use without keys. Always labelled "simulator".
//   FaultInjectingProvider wraps another provider and breaks the connection on
//                         purpose, to prove recovery works.
//
// Field names follow PayPal's published OpenAPI specifications:
// payments_payment_v2, payments_payouts_batch_v1, reporting_transactions_v1,
// customer_disputes_v1, notifications_webhooks_v1.

export type ProviderEnvironment = "sandbox" | "live" | "simulator";

export type ProviderMoney = { currency_code: string; value: string };

export type CaptureStatus = "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
export type RefundStatus = "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";
export type PayoutBatchStatus = "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";
export type PayoutItemStatus =
  | "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED" | "REFUNDED" | "REVERSED";

export type ProviderCapture = {
  id: string;
  status: CaptureStatus;
  status_reason?: string;
  amount: ProviderMoney;
  invoice_id?: string;
  custom_id?: string;
  create_time?: string;
  update_time?: string;
};

export type ProviderRefund = {
  id: string;
  status: RefundStatus;
  status_reason?: string;
  amount: ProviderMoney;
  invoice_id?: string;
  custom_id?: string;
  /** Total refunded so far against the capture, when PayPal reports it. */
  total_refunded_amount?: ProviderMoney;
  create_time?: string;
};

export type RefundInput = {
  /** Sent as PayPal-Request-Id. The same ID always returns the same refund. */
  requestId: string;
  /** Leave out for a full refund of what is left. */
  amount?: ProviderMoney;
  invoiceId?: string;
  customId?: string;
  noteToPayer?: string;
};

export type ProviderTransaction = {
  transaction_id: string;
  event_code?: string;
  status?: string; // S success, P pending, V reversed, D denied
  initiated_at: string;
  updated_at?: string;
  /** Signed: negative for money leaving the account. */
  amount: ProviderMoney;
  fee?: ProviderMoney;
  invoice_id?: string;
  custom_field?: string;
  reference_id?: string;
  reference_id_type?: string;
  payer?: { account_id?: string; email?: string; name?: string; country_code?: string };
  items: Array<{ code?: string; name?: string; quantity?: string; unit_price?: ProviderMoney }>;
  raw: unknown;
};

export type TransactionPage = {
  transactions: ProviderTransaction[];
  page: number;
  totalPages: number;
  totalItems: number;
  lastRefreshedAt?: string;
};

export type TransactionSearchInput = {
  /** RFC 3339. PayPal allows at most 31 days between start and end. */
  start: string;
  end: string;
  page: number;
  pageSize?: number;
  transactionId?: string;
};

export type PayoutItemInput = {
  senderItemId: string;
  recipientType: "EMAIL" | "PAYPAL_ID";
  receiver: string;
  amount: ProviderMoney;
  note?: string;
};

export type ProviderPayoutItem = {
  payout_item_id: string;
  sender_item_id?: string;
  transaction_id?: string;
  transaction_status: PayoutItemStatus;
  amount?: ProviderMoney;
  fee?: ProviderMoney;
  error_name?: string;
  error_message?: string;
};

export type ProviderPayoutBatch = {
  payout_batch_id: string;
  sender_batch_id?: string;
  batch_status: PayoutBatchStatus;
  items: ProviderPayoutItem[];
};

export type ProviderDispute = {
  dispute_id: string;
  status?: string;
  dispute_state?: string;
  reason?: string;
  transaction_ids: string[];
};

export type WebhookVerificationInput = {
  webhookId: string;
  headers: Record<string, string | undefined>;
  /** The event exactly as received, parsed. */
  event: unknown;
  /**
   * The request body exactly as PayPal sent it. When given, it is passed on
   * byte for byte: re-serialising JSON can change it and break the signature.
   */
  rawBody?: string;
};

export interface PayPalProvider {
  readonly environment: ProviderEnvironment;

  /** Proves the credentials work and reports the permissions PayPal granted. */
  verifyCredentials(): Promise<{ scopes: string[] }>;

  getCapture(captureId: string): Promise<ProviderCapture>;
  refundCapture(captureId: string, input: RefundInput): Promise<ProviderRefund>;
  getRefund(refundId: string): Promise<ProviderRefund>;

  searchTransactions(input: TransactionSearchInput): Promise<TransactionPage>;

  createPayout(input: { senderBatchId: string; emailSubject: string; items: PayoutItemInput[] }): Promise<ProviderPayoutBatch>;
  getPayoutBatch(payoutBatchId: string): Promise<ProviderPayoutBatch>;

  listDisputesForTransaction(transactionId: string): Promise<ProviderDispute[]>;

  verifyWebhookSignature(input: WebhookVerificationInput): Promise<boolean>;
}

// ---------- errors ----------

export type ProviderFailureKind =
  | "rejected" // PayPal understood the request and refused it (4xx with an issue code)
  | "rate_limited" // 429: not processed, try later
  | "auth_error" // 401 or 403: credentials or permissions
  | "server_error" // 5xx
  | "timeout" // no reply in time
  | "network_error"; // the connection failed

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly httpStatus: number | null;
  readonly issue: string | null;
  readonly debugId: string | null;
  readonly body: unknown;
  readonly retryAfterMs: number | null;

  constructor(input: {
    kind: ProviderFailureKind;
    message: string;
    httpStatus?: number | null;
    issue?: string | null;
    debugId?: string | null;
    body?: unknown;
    retryAfterMs?: number | null;
  }) {
    super(input.message);
    this.name = "ProviderError";
    this.kind = input.kind;
    this.httpStatus = input.httpStatus ?? null;
    this.issue = input.issue ?? null;
    this.debugId = input.debugId ?? null;
    this.body = input.body;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }

  /**
   * True when we cannot tell whether PayPal carried out a money-moving request.
   * A timeout, a dropped connection or a 5xx does NOT mean the payment failed.
   * The caller must look the operation up before doing anything else.
   */
  get outcomeUnknown(): boolean {
    return this.kind === "timeout" || this.kind === "network_error" || this.kind === "server_error";
  }
}

export type RefundRejection =
  | { policy: "final"; meaning: string }
  | { policy: "needs_merchant"; meaning: string; pauseBatch: boolean };

/**
 * What a refund rejection means for the operation. An issue we do not know is
 * treated as final: we never guess that a refused refund is safe to retry.
 *
 * Seen from the real sandbox on 11 Nov 2026 (scripts/sandbox-verify.ts):
 * CAPTURE_FULLY_REFUNDED, REFUND_AMOUNT_EXCEEDED, DECIMAL_PRECISION and
 * REFUND_CAPTURE_CURRENCY_MISMATCH, all with HTTP 422. The other names are
 * from PayPal's error reference and have not been triggered by us.
 */
export function classifyRefundRejection(issue: string | null): RefundRejection {
  switch (issue) {
    case "CAPTURE_FULLY_REFUNDED":
      return { policy: "final", meaning: "The payment was already refunded in full." };
    case "REFUND_AMOUNT_EXCEEDED":
      return { policy: "final", meaning: "The amount is more than what is left to refund on this payment." };
    case "REFUND_TIME_LIMIT_EXCEEDED":
    case "REFUND_NOT_ALLOWED":
      return { policy: "final", meaning: "PayPal no longer allows a refund of this payment. Use a payout instead." };
    case "TRANSACTION_DISPUTED":
    case "REFUND_NOT_PERMITTED_DUE_TO_CHARGEBACK":
      return { policy: "final", meaning: "The payment is in a dispute or chargeback. Resolve it in PayPal first." };
    case "REFUND_CAPTURE_CURRENCY_MISMATCH": // the name the sandbox returned on 11 Nov 2026
    case "CURRENCY_MISMATCH":
    case "INVALID_CURRENCY_CODE":
    case "DECIMAL_PRECISION":
      return { policy: "final", meaning: "The refund must be in the currency and precision of the original payment." };
    case "PARTIAL_REFUND_NOT_ALLOWED":
    case "MAX_NUMBER_OF_REFUNDS_EXCEEDED":
    case "PENDING_CAPTURE":
    case "CANNOT_PROCESS_REFUNDS":
      return { policy: "final", meaning: "PayPal cannot refund this payment in this way." };
    case "REFUND_FAILED_INSUFFICIENT_FUNDS":
      return {
        policy: "needs_merchant",
        meaning: "The PayPal balance is too low to fund this refund. Add funds, then resume.",
        pauseBatch: true,
      };
    default:
      return { policy: "final", meaning: `PayPal refused the refund${issue ? ` (${issue})` : ""}.` };
  }
}
