// The parts of PayPal that Make Good uses, as one small interface. The sandbox REST client and
// the offline mock both implement it with PayPal's own response shapes.

export interface Money {
  currency_code: string;
  value: string;
}

export interface OrderItem {
  name: string;
  sku?: string;
  quantity: string;
  unit_amount: Money;
}

export interface CreateOrderRequest {
  intent: "CAPTURE";
  purchase_units: Array<{
    invoice_id?: string;
    custom_id?: string;
    description?: string;
    amount: Money & { breakdown?: { item_total?: Money; tax_total?: Money; shipping?: Money; discount?: Money } };
    items?: OrderItem[];
  }>;
  payment_source?: Record<string, unknown>;
}

export interface Order {
  id: string;
  status: string;
  purchase_units?: Array<{ payments?: { captures?: Array<{ id: string; status: string; amount: Money }> } }>;
  links?: Array<{ href: string; rel: string }>;
}

export interface Capture {
  id: string;
  status: "COMPLETED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "PENDING" | "DECLINED" | "FAILED";
  amount: Money;
  invoice_id?: string;
  create_time?: string;
}

export interface Refund {
  id: string;
  status: "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED";
  amount: Money;
}

/** One row of GET /v1/reporting/transactions (only the fields Make Good reads). */
export interface TransactionDetail {
  transaction_info: {
    transaction_id: string;
    transaction_event_code?: string;
    transaction_initiation_date: string;
    transaction_amount: Money;
    transaction_status?: string;
    invoice_id?: string;
    custom_field?: string;
    paypal_reference_id?: string;
  };
  payer_info?: {
    email_address?: string;
    payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
  };
  cart_info?: {
    item_details?: Array<{
      item_code?: string;
      item_name?: string;
      item_quantity?: string;
      item_unit_price?: Money;
      item_amount?: Money;
    }>;
  };
}

export interface TransactionPage {
  transaction_details: TransactionDetail[];
  total_pages: number;
  page: number;
}

export interface PayoutItemRequest {
  sender_item_id: string;
  receiver: string; // email
  amount: Money;
  note?: string;
}

export interface PayoutItem {
  payout_item_id: string;
  sender_item_id: string;
  transaction_status: "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED" | "REFUNDED" | "REVERSED";
  receiver: string;
  amount: Money;
  error?: string;
}

export interface PayoutBatch {
  payout_batch_id: string;
  batch_status: "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";
  items: PayoutItem[];
}

export interface Dispute {
  dispute_id: string;
  status: string;
  reason?: string;
  transaction_ids: string[];
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public issue: string,
    public debugId: string | undefined,
    public details: unknown,
  ) {
    super(`PayPal ${status} ${issue}${debugId ? ` (debug_id ${debugId})` : ""}`);
  }
}

export interface PayPalApi {
  readonly mode: "mock" | "sandbox";
  createOrder(body: CreateOrderRequest, requestId: string): Promise<Order>;
  captureOrder(orderId: string, requestId: string): Promise<Order>;
  /** One window of at most 31 days. `page` starts at 1. */
  listTransactions(startIso: string, endIso: string, page: number): Promise<TransactionPage>;
  getCapture(captureId: string): Promise<Capture>;
  /** Omit `amount` for a full refund of what is left. */
  refundCapture(captureId: string, requestId: string, amount?: Money, note?: string): Promise<Refund>;
  getRefund(refundId: string): Promise<Refund>;
  createPayout(senderBatchId: string, items: PayoutItemRequest[], subject: string): Promise<PayoutBatch>;
  getPayout(payoutBatchId: string): Promise<PayoutBatch>;
  listOpenDisputes(): Promise<Dispute[]>;
  /** Available balance in cents, or null when PayPal does not say. */
  getBalance(currency: string): Promise<number | null>;
  verifyWebhook(headers: Record<string, string | undefined>, body: unknown): Promise<boolean>;
}
