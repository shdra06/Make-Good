// The real PayPal REST client.
//
// Safety properties
//   * The host is chosen from the environment name. "live" must be allowed
//     explicitly when the client is built; the default refuses it.
//   * Every money-moving POST carries a PayPal-Request-Id supplied by the
//     caller, so repeating a call cannot move money twice.
//   * Every call has a time limit. A call that times out is reported as
//     "outcome unknown", never as a failure.
//   * Secrets are held in memory only and never appear in errors or logs.

import {
  ProviderError,
  type PayPalProvider,
  type PayoutItemInput,
  type ProviderCapture,
  type ProviderDispute,
  type ProviderEnvironment,
  type ProviderPayoutBatch,
  type ProviderRefund,
  type ProviderTransaction,
  type RefundInput,
  type TransactionPage,
  type TransactionSearchInput,
  type WebhookVerificationInput,
} from "./provider.ts";

const HOSTS: Record<"sandbox" | "live", string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export type RestClientOptions = {
  environment: "sandbox" | "live";
  clientId: string;
  clientSecret: string;
  /**
   * Partner mode: the PayPal account ID of the merchant we act for. Adds the
   * PayPal-Auth-Assertion header. Requires PayPal partner approval and the
   * merchant's consent through seller onboarding.
   */
  actingForMerchantId?: string;
  /** Must be true to build a live client. Never true by default. */
  allowLive?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
function money(value: unknown): { currency_code: string; value: string } | undefined {
  const m = asRecord(value);
  const code = asString(m.currency_code) ?? asString(m.currency);
  const amount = asString(m.value);
  return code && amount ? { currency_code: code, value: amount } : undefined;
}

export class PayPalRestClient implements PayPalProvider {
  readonly environment: ProviderEnvironment;
  readonly #base: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #merchantId: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #token: { value: string; expiresAt: number; scopes: string[] } | null = null;

  constructor(options: RestClientOptions) {
    if (options.environment === "live" && options.allowLive !== true) {
      throw new Error("Live PayPal access is switched off. It needs separate, deliberate configuration.");
    }
    this.environment = options.environment;
    this.#base = HOSTS[options.environment];
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#merchantId = options.actingForMerchantId;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  // ---------- transport ----------

  async #send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ProviderError({ kind: "timeout", message: `PayPal did not answer within ${this.#timeoutMs} ms.` });
      }
      throw new ProviderError({ kind: "network_error", message: "Could not reach PayPal." });
    } finally {
      clearTimeout(timer);
    }
  }

  async #accessToken(): Promise<{ value: string; scopes: string[] }> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token;
    const res = await this.#send(`${this.#base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = asRecord(await res.json().catch(() => ({})));
    const token = asString(body.access_token);
    if (!res.ok || !token) {
      throw new ProviderError({
        kind: res.status >= 500 ? "server_error" : "auth_error",
        httpStatus: res.status,
        issue: asString(body.error) ?? "AUTHENTICATION_FAILURE",
        debugId: res.headers.get("paypal-debug-id"),
        message: `PayPal refused the credentials: ${asString(body.error_description) ?? asString(body.error) ?? res.statusText}`,
      });
    }
    this.#token = {
      value: token,
      expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000,
      scopes: (asString(body.scope) ?? "").split(" ").filter(Boolean),
    };
    return this.#token;
  }

  /** Unsigned JWT naming the merchant, as PayPal's multiparty documentation describes. */
  #authAssertion(): string {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return `${enc({ alg: "none" })}.${enc({ iss: this.#clientId, payer_id: this.#merchantId })}.`;
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; rawBody?: string; requestId?: string; full?: boolean } = {},
    retriedAuth = false,
  ): Promise<Json> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.value}`,
      "Content-Type": "application/json",
    };
    if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;
    if (options.full) headers.Prefer = "return=representation";
    if (this.#merchantId) headers["PayPal-Auth-Assertion"] = this.#authAssertion();

    const res = await this.#send(`${this.#base}${path}`, {
      method,
      headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    if (res.status === 401 && !retriedAuth) {
      this.#token = null;
      return this.#call(method, path, options, true);
    }
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 2000) };
      }
    }
    if (res.ok) return asRecord(body);

    const err = asRecord(body);
    const details = Array.isArray(err.details) ? (err.details as unknown[]).map(asRecord) : [];
    const issue = asString(details[0]?.issue) ?? asString(err.name) ?? `HTTP_${res.status}`;
    const description = asString(details[0]?.description) ?? asString(err.message) ?? res.statusText;
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ProviderError({
      kind:
        res.status === 429 ? "rate_limited"
        : res.status === 401 || res.status === 403 ? "auth_error"
        : res.status >= 500 ? "server_error"
        : "rejected",
      httpStatus: res.status,
      issue,
      debugId: asString(err.debug_id) ?? res.headers.get("paypal-debug-id"),
      body,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      message: `PayPal ${method} ${path.split("?")[0]} failed: ${issue}. ${description}`,
    });
  }

  // ---------- operations ----------

  async verifyCredentials(): Promise<{ scopes: string[] }> {
    this.#token = null;
    const token = await this.#accessToken();
    return { scopes: token.scopes };
  }

  async getCapture(captureId: string): Promise<ProviderCapture> {
    return toCapture(await this.#call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`));
  }

  async refundCapture(captureId: string, input: RefundInput): Promise<ProviderRefund> {
    const body: Json = {};
    if (input.amount) body.amount = input.amount;
    if (input.invoiceId) body.invoice_id = input.invoiceId.slice(0, 127);
    if (input.customId) body.custom_id = input.customId.slice(0, 127);
    if (input.noteToPayer) body.note_to_payer = input.noteToPayer.slice(0, 255);
    return toRefund(
      await this.#call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
        body,
        requestId: input.requestId,
        full: true,
      }),
    );
  }

  async getRefund(refundId: string): Promise<ProviderRefund> {
    return toRefund(await this.#call("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`));
  }

  async searchTransactions(input: TransactionSearchInput): Promise<TransactionPage> {
    const query = new URLSearchParams({
      start_date: input.start,
      end_date: input.end,
      fields: "all",
      page_size: String(Math.min(500, Math.max(1, input.pageSize ?? 500))),
      page: String(input.page),
    });
    if (input.transactionId) query.set("transaction_id", input.transactionId);
    const body = await this.#call("GET", `/v1/reporting/transactions?${query.toString()}`);
    const details = Array.isArray(body.transaction_details) ? (body.transaction_details as unknown[]) : [];
    return {
      transactions: details.map(toTransaction).filter((t): t is ProviderTransaction => t !== null),
      page: Number(body.page) || input.page,
      totalPages: Number(body.total_pages) || 1,
      totalItems: Number(body.total_items) || details.length,
      lastRefreshedAt: asString(body.last_refreshed_datetime),
    };
  }

  async createPayout(input: {
    senderBatchId: string;
    emailSubject: string;
    items: PayoutItemInput[];
  }): Promise<ProviderPayoutBatch> {
    const body = await this.#call("POST", "/v1/payments/payouts", {
      requestId: input.senderBatchId,
      body: {
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          email_subject: input.emailSubject.slice(0, 255),
        },
        items: input.items.map((item) => ({
          recipient_type: item.recipientType,
          receiver: item.receiver,
          amount: { currency: item.amount.currency_code, value: item.amount.value },
          note: item.note?.slice(0, 4000),
          sender_item_id: item.senderItemId,
        })),
      },
    });
    const header = asRecord(body.batch_header);
    return {
      payout_batch_id: asString(header.payout_batch_id) ?? "",
      sender_batch_id: input.senderBatchId,
      batch_status: (asString(header.batch_status) ?? "PENDING") as ProviderPayoutBatch["batch_status"],
      items: [],
    };
  }

  async getPayoutBatch(payoutBatchId: string): Promise<ProviderPayoutBatch> {
    const body = await this.#call(
      "GET",
      `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?page_size=1000&total_required=true`,
    );
    const header = asRecord(body.batch_header);
    const items = Array.isArray(body.items) ? (body.items as unknown[]).map(asRecord) : [];
    return {
      payout_batch_id: asString(header.payout_batch_id) ?? payoutBatchId,
      sender_batch_id: asString(asRecord(header.sender_batch_header).sender_batch_id),
      batch_status: (asString(header.batch_status) ?? "PENDING") as ProviderPayoutBatch["batch_status"],
      items: items.map((item) => {
        const inner = asRecord(item.payout_item);
        const errors = asRecord(item.errors);
        return {
          payout_item_id: asString(item.payout_item_id) ?? "",
          sender_item_id: asString(inner.sender_item_id),
          transaction_id: asString(item.transaction_id),
          transaction_status: (asString(item.transaction_status) ?? "PENDING") as ProviderPayoutBatch["items"][number]["transaction_status"],
          amount: money(inner.amount),
          fee: money(item.payout_item_fee),
          error_name: asString(errors.name),
          error_message: asString(errors.message),
        };
      }),
    };
  }

  async listDisputesForTransaction(transactionId: string): Promise<ProviderDispute[]> {
    const body = await this.#call(
      "GET",
      `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(transactionId)}`,
    );
    const items = Array.isArray(body.items) ? (body.items as unknown[]).map(asRecord) : [];
    return items.map((d) => ({
      dispute_id: asString(d.dispute_id) ?? "",
      status: asString(d.status),
      dispute_state: asString(d.dispute_state),
      reason: asString(d.reason),
      transaction_ids: [transactionId],
    }));
  }

  async verifyWebhookSignature(input: WebhookVerificationInput): Promise<boolean> {
    const h = input.headers;
    const envelope = {
      auth_algo: h["paypal-auth-algo"],
      cert_url: h["paypal-cert-url"],
      transmission_id: h["paypal-transmission-id"],
      transmission_sig: h["paypal-transmission-sig"],
      transmission_time: h["paypal-transmission-time"],
      webhook_id: input.webhookId,
    };
    // The event goes in exactly as received. Parsing and re-writing it can
    // change number formats or key order, and PayPal then reports FAILURE.
    const rawBody = input.rawBody
      ? `${JSON.stringify(envelope).slice(0, -1)},"webhook_event":${input.rawBody}}`
      : undefined;
    const body = await this.#call("POST", "/v1/notifications/verify-webhook-signature", {
      body: { ...envelope, webhook_event: input.event },
      rawBody,
    });
    return body.verification_status === "SUCCESS";
  }

  /**
   * Starts PayPal seller onboarding for a merchant (partner mode). Returns the
   * address the merchant opens to grant us permission. Requires an approved
   * PayPal partner account; a normal app is refused by PayPal.
   */
  async createPartnerReferral(input: { trackingId: string; returnUrl: string; email?: string }): Promise<{ actionUrl: string | null; referralId: string | null }> {
    const body = await this.#call("POST", "/v2/customer/partner-referrals", {
      body: {
        tracking_id: input.trackingId,
        email: input.email,
        partner_config_override: { return_url: input.returnUrl },
        operations: [
          {
            operation: "API_INTEGRATION",
            api_integration_preference: {
              rest_api_integration: {
                integration_method: "PAYPAL",
                integration_type: "THIRD_PARTY",
                third_party_details: {
                  features: ["PAYMENT", "REFUND", "PAYOUTS", "READ_SELLER_DISPUTE", "ADVANCED_TRANSACTIONS_SEARCH", "ACCESS_MERCHANT_INFORMATION"],
                },
              },
            },
          },
        ],
        products: ["EXPRESS_CHECKOUT"],
        legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      },
    });
    const links = Array.isArray(body.links) ? (body.links as unknown[]).map(asRecord) : [];
    const action = links.find((l) => l.rel === "action_url");
    const self = links.find((l) => l.rel === "self");
    return { actionUrl: asString(action?.href) ?? null, referralId: asString(self?.href)?.split("/").pop() ?? null };
  }
}

// ---------- mapping PayPal's JSON to our types ----------

function toCapture(body: Json): ProviderCapture {
  return {
    id: asString(body.id) ?? "",
    status: (asString(body.status) ?? "PENDING") as ProviderCapture["status"],
    status_reason: asString(asRecord(body.status_details).reason),
    amount: money(body.amount) ?? { currency_code: "", value: "0" },
    invoice_id: asString(body.invoice_id),
    custom_id: asString(body.custom_id),
    create_time: asString(body.create_time),
    update_time: asString(body.update_time),
  };
}

function toRefund(body: Json): ProviderRefund {
  const breakdown = asRecord(body.seller_payable_breakdown);
  return {
    id: asString(body.id) ?? "",
    status: (asString(body.status) ?? "PENDING") as ProviderRefund["status"],
    status_reason: asString(asRecord(body.status_details).reason),
    amount: money(body.amount) ?? { currency_code: "", value: "0" },
    invoice_id: asString(body.invoice_id),
    custom_id: asString(body.custom_id),
    total_refunded_amount: money(breakdown.total_refunded_amount),
    create_time: asString(body.create_time),
  };
}

function toTransaction(value: unknown): ProviderTransaction | null {
  const detail = asRecord(value);
  const info = asRecord(detail.transaction_info);
  const id = asString(info.transaction_id);
  const amount = money(info.transaction_amount);
  const when = asString(info.transaction_initiation_date);
  if (!id || !amount || !when) return null;
  const payer = asRecord(detail.payer_info);
  const name = asRecord(payer.payer_name);
  const cart = asRecord(detail.cart_info);
  const items = Array.isArray(cart.item_details) ? (cart.item_details as unknown[]).map(asRecord) : [];
  return {
    transaction_id: id,
    event_code: asString(info.transaction_event_code),
    status: asString(info.transaction_status),
    initiated_at: when,
    updated_at: asString(info.transaction_updated_date),
    amount,
    fee: money(info.fee_amount),
    invoice_id: asString(info.invoice_id),
    custom_field: asString(info.custom_field),
    reference_id: asString(info.paypal_reference_id),
    reference_id_type: asString(info.paypal_reference_id_type),
    payer: {
      account_id: asString(payer.account_id),
      email: asString(payer.email_address),
      name: asString(name.alternate_full_name) ?? ([asString(name.given_name), asString(name.surname)].filter(Boolean).join(" ") || undefined),
      country_code: asString(payer.country_code),
    },
    items: items.map((i) => ({
      code: asString(i.item_code),
      name: asString(i.item_name),
      quantity: asString(i.item_quantity),
      unit_price: money(i.item_unit_price),
    })),
    raw: value,
  };
}
