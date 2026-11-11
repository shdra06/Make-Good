// PayPal REST client for the SANDBOX only. Every POST carries a PayPal-Request-Id, so a retry
// can never create a second refund or payout.
import { config } from "../config.ts";
import { toCents } from "../money.ts";
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
  type TransactionPage,
} from "./types.ts";

const SANDBOX_HOST = "api-m.sandbox.paypal.com";

export class SandboxPayPal implements PayPalApi {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private clientId = config.paypal.clientId,
    private clientSecret = config.paypal.clientSecret,
    private baseUrl = config.paypal.baseUrl,
  ) {
    if (new URL(baseUrl).host !== SANDBOX_HOST) {
      throw new Error(`Refusing to use ${baseUrl}: Make Good only talks to the PayPal sandbox.`);
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new PayPalError(res.status, json.error_description ?? "AUTHENTICATION_FAILURE", undefined, json);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const issue = json?.details?.[0]?.issue ?? json?.name ?? `HTTP_${res.status}`;
      throw new PayPalError(res.status, issue, json?.debug_id, json);
    }
    return json as T;
  }

  createOrder(body: CreateOrderRequest, requestId: string) {
    return this.call<Order>("POST", "/v2/checkout/orders", body, requestId);
  }

  captureOrder(orderId: string, requestId: string) {
    return this.call<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
  }

  listTransactions(startIso: string, endIso: string, page: number) {
    const q = new URLSearchParams({
      start_date: startIso,
      end_date: endIso,
      fields: "all",
      page_size: "500",
      page: String(page),
    });
    return this.call<TransactionPage>("GET", `/v1/reporting/transactions?${q}`);
  }

  getCapture(captureId: string) {
    return this.call<Capture>("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  }

  refundCapture(captureId: string, requestId: string, amount?: Money, note?: string) {
    const body: Record<string, unknown> = {};
    if (amount) body.amount = amount;
    if (note) body.note_to_payer = note.slice(0, 255);
    return this.call<Refund>("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, requestId);
  }

  getRefund(refundId: string) {
    return this.call<Refund>("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
  }

  async createPayout(senderBatchId: string, items: PayoutItemRequest[], subject: string): Promise<PayoutBatch> {
    const out = await this.call<{ batch_header: { payout_batch_id: string } }>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: subject.slice(0, 255) },
        items: items.map((it) => ({
          recipient_type: "EMAIL",
          receiver: it.receiver,
          amount: { value: it.amount.value, currency: it.amount.currency_code },
          note: it.note?.slice(0, 4000),
          sender_item_id: it.sender_item_id,
        })),
      },
      senderBatchId,
    );
    return this.getPayout(out.batch_header.payout_batch_id);
  }

  async getPayout(payoutBatchId: string): Promise<PayoutBatch> {
    const out = await this.call<any>("GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?page_size=1000`);
    return {
      payout_batch_id: out.batch_header.payout_batch_id,
      batch_status: out.batch_header.batch_status,
      items: (out.items ?? []).map((it: any) => ({
        payout_item_id: it.payout_item_id,
        sender_item_id: it.payout_item?.sender_item_id,
        transaction_status: it.transaction_status,
        receiver: it.payout_item?.receiver,
        amount: { currency_code: it.payout_item?.amount?.currency, value: it.payout_item?.amount?.value },
        error: it.errors?.name,
      })),
    };
  }

  async listOpenDisputes(): Promise<Dispute[]> {
    const out = await this.call<any>("GET", "/v1/customer/disputes?page_size=50");
    return (out.items ?? [])
      .filter((d: any) => d.status !== "RESOLVED")
      .map((d: any) => ({
        dispute_id: d.dispute_id,
        status: d.status,
        reason: d.reason,
        transaction_ids: (d.disputed_transactions ?? []).map((t: any) => t.seller_transaction_id).filter(Boolean),
      }));
  }

  async getBalance(currency: string): Promise<number | null> {
    try {
      const out = await this.call<any>("GET", `/v1/reporting/balances?currency_code=${encodeURIComponent(currency)}`);
      const b = (out.balances ?? []).find((x: any) => x.currency === currency);
      return b?.available_balance?.value ? toCents(b.available_balance.value) : null;
    } catch {
      return null; // the balance check is advisory; a missing permission must not block a run
    }
  }

  async verifyWebhook(headers: Record<string, string | undefined>, body: unknown): Promise<boolean> {
    if (!config.paypal.webhookId) return false;
    const out = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: config.paypal.webhookId,
      webhook_event: body,
    });
    return out.verification_status === "SUCCESS";
  }
}
