// An offline stand-in for the PayPal sandbox. It keeps the same response shapes and enforces the
// same rules Make Good depends on: one refund request ID = one refund, no refund above what was
// captured, no refund after 180 days, no part refund while a dispute is open.
// Every ID it issues starts with "MOCK-", so it can never be mistaken for a PayPal record.
import crypto from "node:crypto";
import { REFUND_WINDOW_DAYS } from "../config.ts";
import { fmt, toCents } from "../money.ts";
import {
  PayPalError,
  type Capture,
  type CreateOrderRequest,
  type Dispute,
  type Money,
  type Order,
  type PayPalApi,
  type PayoutBatch,
  type PayoutItemRequest,
  type Refund,
  type TransactionDetail,
  type TransactionPage,
} from "./types.ts";

const mockId = (kind: string) => `MOCK-${kind}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
const fail = (status: number, issue: string): never => {
  throw new PayPalError(status, issue, undefined, { details: [{ issue }] });
};

export interface MockPayment {
  payerEmail: string;
  payerName: string;
  amountCents: number;
  currency?: string;
  invoiceId?: string;
  paidAt: string; // ISO
  items?: Array<{ sku: string; name: string; qty: number; unitCents: number }>;
  /** Sent at checkout without item details (some shops do this). */
  hideItems?: boolean;
}

interface StoredCapture {
  id: string;
  payment: MockPayment;
  refundedCents: number;
}

export class MockPayPal implements PayPalApi {
  readonly mode = "mock" as const;
  private captures = new Map<string, StoredCapture>();
  private refunds = new Map<string, Refund & { captureId: string; at: string }>();
  private payouts = new Map<string, PayoutBatch>();
  private disputes: Dispute[] = [];
  private idempotent = new Map<string, unknown>();
  private pendingOrders = new Map<string, CreateOrderRequest>();
  /** Emails that have a PayPal account; payouts to others stay UNCLAIMED. */
  knownEmails = new Set<string>();
  balanceCents = 5_000_000;

  private once<T>(key: string, fn: () => T): T {
    if (this.idempotent.has(key)) return structuredClone(this.idempotent.get(key) as T);
    const out = fn();
    this.idempotent.set(key, structuredClone(out));
    return out;
  }

  // ---- mock-only helpers used by the seed script and tests ----
  seedPayment(p: MockPayment): string {
    const id = mockId("CAP");
    this.captures.set(id, { id, payment: { currency: "USD", ...p }, refundedCents: 0 });
    this.knownEmails.add(p.payerEmail.toLowerCase());
    return id;
  }

  seedDispute(captureId: string, reason = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"): string {
    const d: Dispute = { dispute_id: mockId("DISPUTE"), status: "OPEN", reason, transaction_ids: [captureId] };
    this.disputes.push(d);
    return d.dispute_id;
  }

  reset() {
    this.captures.clear();
    this.refunds.clear();
    this.payouts.clear();
    this.disputes = [];
    this.idempotent.clear();
    this.knownEmails.clear();
  }

  // ---- PayPalApi ----
  async createOrder(body: CreateOrderRequest, requestId: string): Promise<Order> {
    return this.once(`order:${requestId}`, () => {
      const id = mockId("ORDER");
      this.pendingOrders.set(id, body);
      return { id, status: "APPROVED" };
    });
  }

  async captureOrder(orderId: string, requestId: string): Promise<Order> {
    return this.once(`capture:${requestId}`, () => {
      const body = this.pendingOrders.get(orderId) ?? fail(404, "RESOURCE_NOT_FOUND");
      const pu = body.purchase_units[0];
      const capId = this.seedPayment({
        payerEmail: "sandbox-buyer@example.com",
        payerName: "Sandbox Buyer",
        amountCents: toCents(pu.amount.value),
        currency: pu.amount.currency_code,
        invoiceId: pu.invoice_id,
        paidAt: new Date().toISOString(),
        items: (pu.items ?? []).map((it) => ({ sku: it.sku ?? "", name: it.name, qty: Number(it.quantity), unitCents: toCents(it.unit_amount.value) })),
      });
      return { id: orderId, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: capId, status: "COMPLETED", amount: pu.amount }] } }] };
    });
  }

  async listTransactions(startIso: string, endIso: string, page: number): Promise<TransactionPage> {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (end - start > 31 * 86400_000 + 1000) fail(400, "INVALID_REQUEST"); // PayPal: at most 31 days per request
    const rows: TransactionDetail[] = [];
    for (const c of this.captures.values()) {
      const t = Date.parse(c.payment.paidAt);
      if (t < start || t > end) continue;
      const [given, ...rest] = c.payment.payerName.split(" ");
      rows.push({
        transaction_info: {
          transaction_id: c.id,
          transaction_event_code: "T0006",
          transaction_initiation_date: c.payment.paidAt,
          transaction_amount: { currency_code: c.payment.currency ?? "USD", value: fmt(c.payment.amountCents) },
          transaction_status: "S",
          invoice_id: c.payment.invoiceId,
        },
        payer_info: { email_address: c.payment.payerEmail, payer_name: { given_name: given, surname: rest.join(" ") } },
        cart_info: c.payment.hideItems
          ? {}
          : {
              item_details: (c.payment.items ?? []).map((it) => ({
                item_code: it.sku,
                item_name: it.name,
                item_quantity: String(it.qty),
                item_unit_price: { currency_code: "USD", value: fmt(it.unitCents) },
              })),
            },
      });
    }
    for (const r of this.refunds.values()) {
      const t = Date.parse(r.at);
      if (t < start || t > end) continue;
      rows.push({
        transaction_info: {
          transaction_id: r.id,
          transaction_event_code: "T1107",
          transaction_initiation_date: r.at,
          transaction_amount: { currency_code: r.amount.currency_code, value: `-${r.amount.value}` },
          transaction_status: "S",
          paypal_reference_id: r.captureId,
        },
      });
    }
    rows.sort((a, b) => a.transaction_info.transaction_initiation_date.localeCompare(b.transaction_info.transaction_initiation_date));
    const size = 500;
    return { transaction_details: rows.slice((page - 1) * size, page * size), total_pages: Math.max(1, Math.ceil(rows.length / size)), page };
  }

  async getCapture(captureId: string): Promise<Capture> {
    const c = this.captures.get(captureId) ?? fail(404, "RESOURCE_NOT_FOUND");
    const status = c.refundedCents === 0 ? "COMPLETED" : c.refundedCents >= c.payment.amountCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
    return { id: c.id, status, amount: { currency_code: c.payment.currency ?? "USD", value: fmt(c.payment.amountCents) }, invoice_id: c.payment.invoiceId, create_time: c.payment.paidAt };
  }

  async refundCapture(captureId: string, requestId: string, amount?: Money): Promise<Refund> {
    return this.once(`refund:${requestId}`, () => {
      const c = this.captures.get(captureId) ?? fail(404, "RESOURCE_NOT_FOUND");
      const left = c.payment.amountCents - c.refundedCents;
      if (left <= 0) fail(422, "CAPTURE_FULLY_REFUNDED");
      const ageDays = (Date.now() - Date.parse(c.payment.paidAt)) / 86400_000;
      if (ageDays > REFUND_WINDOW_DAYS) fail(422, "REFUND_TIME_LIMIT_EXCEEDED");
      const want = amount ? toCents(amount.value) : left;
      if (want <= 0) fail(400, "INVALID_PARAMETER_VALUE");
      if (want > left) fail(422, "REFUND_AMOUNT_EXCEEDED");
      if (want < left && this.disputes.some((d) => d.status !== "RESOLVED" && d.transaction_ids.includes(captureId))) fail(422, "TRANSACTION_DISPUTED");
      if (want > this.balanceCents) fail(422, "REFUND_FAILED_INSUFFICIENT_FUNDS");
      c.refundedCents += want;
      this.balanceCents -= want;
      const r = { id: mockId("REFUND"), status: "COMPLETED" as const, amount: { currency_code: c.payment.currency ?? "USD", value: fmt(want) }, captureId, at: new Date().toISOString() };
      this.refunds.set(r.id, r);
      return { id: r.id, status: r.status, amount: r.amount };
    });
  }

  async getRefund(refundId: string): Promise<Refund> {
    const r = this.refunds.get(refundId) ?? fail(404, "RESOURCE_NOT_FOUND");
    return { id: r.id, status: r.status, amount: r.amount };
  }

  async createPayout(senderBatchId: string, items: PayoutItemRequest[]): Promise<PayoutBatch> {
    return this.once(`payout:${senderBatchId}`, () => {
      const total = items.reduce((s, it) => s + toCents(it.amount.value), 0);
      if (total > this.balanceCents) fail(422, "INSUFFICIENT_FUNDS");
      this.balanceCents -= total;
      const batch: PayoutBatch = {
        payout_batch_id: mockId("PAYOUT"),
        batch_status: "SUCCESS",
        items: items.map((it) => ({
          payout_item_id: mockId("ITEM"),
          sender_item_id: it.sender_item_id,
          transaction_status: this.knownEmails.has(it.receiver.toLowerCase()) ? ("SUCCESS" as const) : ("UNCLAIMED" as const),
          receiver: it.receiver,
          amount: it.amount,
        })),
      };
      this.payouts.set(batch.payout_batch_id, batch);
      return batch;
    });
  }

  async getPayout(payoutBatchId: string): Promise<PayoutBatch> {
    return structuredClone(this.payouts.get(payoutBatchId) ?? fail(404, "RESOURCE_NOT_FOUND"));
  }

  async listOpenDisputes(): Promise<Dispute[]> {
    return structuredClone(this.disputes.filter((d) => d.status !== "RESOLVED"));
  }

  async getBalance(): Promise<number | null> {
    return this.balanceCents;
  }

  async verifyWebhook(): Promise<boolean> {
    return false; // the mock sends no webhooks; states are read back directly
  }
}
