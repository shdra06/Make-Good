// An in-memory model of the parts of PayPal that Make Good uses.
//
// It exists for two reasons only:
//   1. automated tests, where every failure mode must be reproducible;
//   2. trying the product locally before PayPal keys exist.
//
// It is never presented as PayPal. Its environment is "simulator", every ID it
// creates starts with "SIM", and connections that use it are labelled on every
// screen. It follows PayPal's documented rules (idempotent request IDs, refund
// limits, the 180-day refund window) so that code proven here behaves the same
// against the real API, but it is a model, not a recording of PayPal.

import { fromMinor, toMinor } from "../../platform/money.ts";
import {
  ProviderError,
  type PayPalProvider,
  type PayoutItemInput,
  type ProviderCapture,
  type ProviderDispute,
  type ProviderPayoutBatch,
  type ProviderPayoutItem,
  type ProviderRefund,
  type ProviderTransaction,
  type RefundInput,
  type TransactionPage,
  type TransactionSearchInput,
  type WebhookVerificationInput,
} from "./provider.ts";

export type SimCapture = {
  id: string;
  currency: string;
  amountMinor: number;
  refundedMinor: number;
  createdAt: Date;
  invoiceId?: string;
  customId?: string;
  payerEmail?: string;
  payerName?: string;
  payerId?: string;
  payerCountry?: string;
  items: Array<{ code?: string; name?: string; quantity: number; unitMinor: number }>;
  disputed: boolean;
  /** Refunds against this capture stay PENDING until settlePending() is called. */
  refundsPending: boolean;
};

type SimRefund = {
  id: string;
  captureId: string;
  currency: string;
  amountMinor: number;
  status: ProviderRefund["status"];
  createdAt: Date;
  invoiceId?: string;
  customId?: string;
};

export type FaultOperation = "refund" | "payout" | "getRefund" | "getCapture" | "getPayout" | "search" | "disputes";

export type Fault = {
  on: FaultOperation;
  /**
   * "before": the request never reaches PayPal. Nothing happens.
   * "after":  PayPal carries the request out, but the reply is lost.
   *           This is the dangerous case: the caller sees a failure, the money moved.
   */
  when: "before" | "after";
  kind: "timeout" | "network_error" | "server_error" | "rate_limited";
  times?: number;
};

export const REFUND_WINDOW_DAYS = 180;

export class SimulatedPayPal implements PayPalProvider {
  readonly environment = "simulator" as const;
  readonly captures = new Map<string, SimCapture>();
  readonly refunds = new Map<string, SimRefund>();
  readonly payouts = new Map<string, ProviderPayoutBatch>();
  /** Every call made, in order. Tests assert on this. */
  readonly calls: Array<{ op: FaultOperation | "verify"; requestId?: string; target?: string; applied: boolean }> = [];
  /** Available balance per currency. Undefined means "enough". */
  readonly balanceMinor = new Map<string, number>();

  #now: () => Date;
  #seq = 0;
  #faults: Fault[] = [];
  #refundByRequestId = new Map<string, string>();
  #payoutByRequestId = new Map<string, string>();
  #payoutFailures = new Map<string, { status: ProviderPayoutItem["transaction_status"]; error: string }>();

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  // ---------- test controls ----------

  setClock(now: () => Date): void {
    this.#now = now;
  }

  addCapture(input: Partial<SimCapture> & { amountMinor: number; currency?: string }): SimCapture {
    const capture: SimCapture = {
      id: input.id ?? this.#id("CAP"),
      currency: input.currency ?? "USD",
      amountMinor: input.amountMinor,
      refundedMinor: input.refundedMinor ?? 0,
      createdAt: input.createdAt ?? this.#now(),
      invoiceId: input.invoiceId,
      customId: input.customId,
      payerEmail: input.payerEmail,
      payerName: input.payerName,
      payerId: input.payerId,
      payerCountry: input.payerCountry,
      items: input.items ?? [],
      disputed: input.disputed ?? false,
      refundsPending: input.refundsPending ?? false,
    };
    this.captures.set(capture.id, capture);
    return capture;
  }

  /** Queue a fault. Faults are consumed in order by the first matching call. */
  failNext(fault: Fault): void {
    for (let i = 0; i < (fault.times ?? 1); i++) this.#faults.push({ ...fault, times: 1 });
  }

  /** Make a payout to this receiver end in a given item status. */
  failPayoutTo(receiver: string, status: ProviderPayoutItem["transaction_status"], error: string): void {
    this.#payoutFailures.set(receiver, { status, error });
  }

  /** PENDING refunds complete (or fail). Models PayPal settling later. */
  settlePending(outcome: "COMPLETED" | "FAILED" = "COMPLETED"): number {
    let changed = 0;
    for (const refund of this.refunds.values()) {
      if (refund.status !== "PENDING") continue;
      refund.status = outcome;
      if (outcome === "FAILED") {
        const capture = this.captures.get(refund.captureId);
        if (capture) capture.refundedMinor -= refund.amountMinor;
      }
      changed++;
    }
    return changed;
  }

  /** Puts back a refund that happened before a restart, so repeated requests still find it. */
  restoreRefund(input: { id: string; captureId: string; currency: string; amountMinor: number; createdAt: Date; requestId?: string; status?: ProviderRefund["status"] }): void {
    this.refunds.set(input.id, {
      id: input.id, captureId: input.captureId, currency: input.currency, amountMinor: input.amountMinor,
      status: input.status ?? "COMPLETED", createdAt: input.createdAt, customId: input.requestId,
    });
    if (input.requestId) this.#refundByRequestId.set(input.requestId, input.id);
  }

  refundCallsFor(captureId: string): number {
    return this.calls.filter((c) => c.op === "refund" && c.target === captureId && c.applied).length;
  }

  // ---------- internals ----------

  #id(prefix: string): string {
    this.#seq += 1;
    return `SIM${prefix}${String(this.#seq).padStart(11, "0")}`;
  }

  #takeFault(on: FaultOperation, when: "before" | "after"): Fault | null {
    const index = this.#faults.findIndex((f) => f.on === on);
    if (index === -1 || this.#faults[index]!.when !== when) return null;
    return this.#faults.splice(index, 1)[0]!;
  }

  #raise(fault: Fault): never {
    throw new ProviderError({
      kind: fault.kind,
      httpStatus: fault.kind === "server_error" ? 503 : fault.kind === "rate_limited" ? 429 : null,
      issue: fault.kind === "rate_limited" ? "RATE_LIMIT_REACHED" : null,
      retryAfterMs: fault.kind === "rate_limited" ? 1000 : null,
      message: `Simulated ${fault.kind} (${fault.when} the request was applied).`,
    });
  }

  /** Runs `apply` with the queued faults for this operation around it. */
  #guard<T>(on: FaultOperation, meta: { requestId?: string; target?: string }, apply: () => T): T {
    const before = this.#takeFault(on, "before");
    if (before) {
      this.calls.push({ op: on, ...meta, applied: false });
      this.#raise(before);
    }
    const result = apply();
    this.calls.push({ op: on, ...meta, applied: true });
    const after = this.#takeFault(on, "after");
    if (after) this.#raise(after);
    return result;
  }

  #reject(issue: string, description: string, status = 422): never {
    throw new ProviderError({
      kind: "rejected",
      httpStatus: status,
      issue,
      debugId: this.#id("DBG"),
      message: `Simulated PayPal refusal: ${issue}. ${description}`,
    });
  }

  #capture(captureId: string): SimCapture {
    const capture = this.captures.get(captureId);
    if (!capture) this.#reject("RESOURCE_NOT_FOUND", "The capture does not exist.", 404);
    return capture;
  }

  #refundView(refund: SimRefund): ProviderRefund {
    const capture = this.captures.get(refund.captureId);
    return {
      id: refund.id,
      status: refund.status,
      amount: { currency_code: refund.currency, value: fromMinor(refund.amountMinor, refund.currency) },
      invoice_id: refund.invoiceId,
      custom_id: refund.customId,
      total_refunded_amount: capture
        ? { currency_code: capture.currency, value: fromMinor(capture.refundedMinor, capture.currency) }
        : undefined,
      create_time: refund.createdAt.toISOString(),
    };
  }

  // ---------- PayPalProvider ----------

  async verifyCredentials(): Promise<{ scopes: string[] }> {
    this.calls.push({ op: "verify", applied: true });
    return { scopes: ["simulator"] };
  }

  async getCapture(captureId: string): Promise<ProviderCapture> {
    return this.#guard("getCapture", { target: captureId }, () => {
      const c = this.#capture(captureId);
      return {
        id: c.id,
        status: c.refundedMinor === 0 ? "COMPLETED" : c.refundedMinor >= c.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED",
        amount: { currency_code: c.currency, value: fromMinor(c.amountMinor, c.currency) },
        invoice_id: c.invoiceId,
        custom_id: c.customId,
        create_time: c.createdAt.toISOString(),
      };
    });
  }

  async refundCapture(captureId: string, input: RefundInput): Promise<ProviderRefund> {
    return this.#guard("refund", { requestId: input.requestId, target: captureId }, () => {
      // Idempotency: the same request ID returns the first result and moves no money.
      const existingId = this.#refundByRequestId.get(input.requestId);
      if (existingId) return this.#refundView(this.refunds.get(existingId)!);

      const capture = this.#capture(captureId);
      const left = capture.amountMinor - capture.refundedMinor;
      if (input.amount && input.amount.currency_code !== capture.currency) {
        this.#reject("CURRENCY_MISMATCH", "The refund currency must match the capture currency.");
      }
      const amountMinor = input.amount ? toMinor(input.amount.value, capture.currency) : left;
      if (capture.disputed) this.#reject("TRANSACTION_DISPUTED", "The capture is in a dispute.");
      const ageDays = (this.#now().getTime() - capture.createdAt.getTime()) / 86_400_000;
      if (ageDays > REFUND_WINDOW_DAYS) {
        this.#reject("REFUND_TIME_LIMIT_EXCEEDED", "The refund window for this capture has passed.");
      }
      if (left <= 0) this.#reject("CAPTURE_FULLY_REFUNDED", "The capture has already been fully refunded.");
      if (amountMinor <= 0) this.#reject("INVALID_PARAMETER_VALUE", "The refund amount must be positive.", 400);
      if (amountMinor > left) this.#reject("REFUND_AMOUNT_EXCEEDED", "The refund amount exceeds the amount left.");
      const balance = this.balanceMinor.get(capture.currency);
      if (balance !== undefined) {
        if (balance < amountMinor) {
          this.#reject("REFUND_FAILED_INSUFFICIENT_FUNDS", "The account balance cannot fund this refund.");
        }
        this.balanceMinor.set(capture.currency, balance - amountMinor);
      }

      const refund: SimRefund = {
        id: this.#id("REF"),
        captureId,
        currency: capture.currency,
        amountMinor,
        status: capture.refundsPending ? "PENDING" : "COMPLETED",
        createdAt: this.#now(),
        invoiceId: input.invoiceId,
        customId: input.customId,
      };
      capture.refundedMinor += amountMinor;
      this.refunds.set(refund.id, refund);
      this.#refundByRequestId.set(input.requestId, refund.id);
      return this.#refundView(refund);
    });
  }

  async getRefund(refundId: string): Promise<ProviderRefund> {
    return this.#guard("getRefund", { target: refundId }, () => {
      const refund = this.refunds.get(refundId);
      if (!refund) this.#reject("RESOURCE_NOT_FOUND", "The refund does not exist.", 404);
      return this.#refundView(refund);
    });
  }

  async searchTransactions(input: TransactionSearchInput): Promise<TransactionPage> {
    return this.#guard("search", {}, () => {
      const start = new Date(input.start).getTime();
      const end = new Date(input.end).getTime();
      if (end - start > 31 * 86_400_000) {
        this.#reject("INVALID_REQUEST", "The date range must not exceed 31 days.", 400);
      }
      const all: ProviderTransaction[] = [];
      for (const c of this.captures.values()) {
        const t = c.createdAt.getTime();
        if (t < start || t > end) continue;
        all.push({
          transaction_id: c.id,
          event_code: "T0006",
          status: "S",
          initiated_at: c.createdAt.toISOString(),
          amount: { currency_code: c.currency, value: fromMinor(c.amountMinor, c.currency) },
          invoice_id: c.invoiceId,
          custom_field: c.customId,
          payer: { account_id: c.payerId, email: c.payerEmail, name: c.payerName, country_code: c.payerCountry },
          items: c.items.map((i) => ({
            code: i.code,
            name: i.name,
            quantity: String(i.quantity),
            unit_price: { currency_code: c.currency, value: fromMinor(i.unitMinor, c.currency) },
          })),
          raw: { simulator: true },
        });
      }
      for (const r of this.refunds.values()) {
        const t = r.createdAt.getTime();
        if (t < start || t > end || r.status === "FAILED" || r.status === "CANCELLED") continue;
        const c = this.captures.get(r.captureId);
        all.push({
          transaction_id: r.id,
          event_code: "T1107",
          status: r.status === "PENDING" ? "P" : "S",
          initiated_at: r.createdAt.toISOString(),
          amount: { currency_code: r.currency, value: fromMinor(-r.amountMinor, r.currency) },
          invoice_id: r.invoiceId,
          custom_field: r.customId,
          reference_id: r.captureId,
          reference_id_type: "TXN",
          payer: { account_id: c?.payerId, email: c?.payerEmail, name: c?.payerName, country_code: c?.payerCountry },
          items: [],
          raw: { simulator: true },
        });
      }
      const filtered = input.transactionId ? all.filter((t) => t.transaction_id === input.transactionId) : all;
      filtered.sort((a, b) => a.initiated_at.localeCompare(b.initiated_at));
      const size = Math.min(500, Math.max(1, input.pageSize ?? 500));
      const totalPages = Math.max(1, Math.ceil(filtered.length / size));
      return {
        transactions: filtered.slice((input.page - 1) * size, input.page * size),
        page: input.page,
        totalPages,
        totalItems: filtered.length,
        lastRefreshedAt: this.#now().toISOString(),
      };
    });
  }

  async createPayout(input: {
    senderBatchId: string;
    emailSubject: string;
    items: PayoutItemInput[];
  }): Promise<ProviderPayoutBatch> {
    return this.#guard("payout", { requestId: input.senderBatchId }, () => {
      const existing = this.#payoutByRequestId.get(input.senderBatchId);
      if (existing) return this.payouts.get(existing)!;
      const total = new Map<string, number>();
      for (const item of input.items) {
        const minor = toMinor(item.amount.value, item.amount.currency_code);
        total.set(item.amount.currency_code, (total.get(item.amount.currency_code) ?? 0) + minor);
      }
      for (const [currency, needed] of total) {
        const balance = this.balanceMinor.get(currency);
        if (balance !== undefined && balance < needed) {
          this.#reject("INSUFFICIENT_FUNDS", "The account balance cannot fund this payout.");
        }
        if (balance !== undefined) this.balanceMinor.set(currency, balance - needed);
      }
      const batch: ProviderPayoutBatch = {
        payout_batch_id: this.#id("PAY"),
        sender_batch_id: input.senderBatchId,
        batch_status: "SUCCESS",
        items: input.items.map((item) => {
          const failure = this.#payoutFailures.get(item.receiver);
          return {
            payout_item_id: this.#id("PIT"),
            sender_item_id: item.senderItemId,
            transaction_id: failure ? undefined : this.#id("PTX"),
            transaction_status: failure?.status ?? "SUCCESS",
            amount: item.amount,
            error_name: failure?.error,
            error_message: failure ? `Simulated: ${failure.error}` : undefined,
          };
        }),
      };
      this.payouts.set(batch.payout_batch_id, batch);
      this.#payoutByRequestId.set(input.senderBatchId, batch.payout_batch_id);
      return batch;
    });
  }

  async getPayoutBatch(payoutBatchId: string): Promise<ProviderPayoutBatch> {
    return this.#guard("getPayout", { target: payoutBatchId }, () => {
      const batch = this.payouts.get(payoutBatchId);
      if (!batch) this.#reject("RESOURCE_NOT_FOUND", "The payout batch does not exist.", 404);
      return batch;
    });
  }

  async listDisputesForTransaction(transactionId: string): Promise<ProviderDispute[]> {
    return this.#guard("disputes", { target: transactionId }, () => {
      const capture = this.captures.get(transactionId);
      if (!capture?.disputed) return [];
      return [
        {
          dispute_id: `SIMDSP${capture.id.slice(-8)}`,
          status: "UNDER_REVIEW",
          dispute_state: "REQUIRED_ACTION",
          reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
          transaction_ids: [transactionId],
        },
      ];
    });
  }

  async verifyWebhookSignature(input: WebhookVerificationInput): Promise<boolean> {
    return input.headers["paypal-transmission-sig"] === "simulator-valid";
  }
}

/**
 * Wraps a real provider and loses replies on purpose. Used in the recovery
 * demonstration against the real sandbox: the PayPal call really happens, and
 * then the reply is thrown away, exactly as a dropped connection would.
 * Only refunds and payouts can be affected.
 */
export class FaultInjectingProvider implements PayPalProvider {
  readonly environment;
  readonly #inner: PayPalProvider;
  #dropNext = 0;
  /** What was injected, for the audit trail of the demonstration. */
  readonly injected: Array<{ op: "refund" | "payout"; requestId: string; at: string }> = [];

  constructor(inner: PayPalProvider) {
    this.#inner = inner;
    this.environment = inner.environment;
  }

  /** The next `count` refunds or payouts go through, but their replies are lost. */
  dropNextReplies(count: number): void {
    this.#dropNext += count;
  }

  #maybeDrop(op: "refund" | "payout", requestId: string): void {
    if (this.#dropNext <= 0) return;
    this.#dropNext -= 1;
    this.injected.push({ op, requestId, at: new Date().toISOString() });
    throw new ProviderError({
      kind: "timeout",
      message: "Injected fault: the request reached PayPal, and the reply was discarded on purpose.",
    });
  }

  verifyCredentials() {
    return this.#inner.verifyCredentials();
  }
  getCapture(captureId: string) {
    return this.#inner.getCapture(captureId);
  }
  async refundCapture(captureId: string, input: RefundInput) {
    const result = await this.#inner.refundCapture(captureId, input);
    this.#maybeDrop("refund", input.requestId);
    return result;
  }
  getRefund(refundId: string) {
    return this.#inner.getRefund(refundId);
  }
  searchTransactions(input: TransactionSearchInput) {
    return this.#inner.searchTransactions(input);
  }
  async createPayout(input: { senderBatchId: string; emailSubject: string; items: PayoutItemInput[] }) {
    const result = await this.#inner.createPayout(input);
    this.#maybeDrop("payout", input.senderBatchId);
    return result;
  }
  getPayoutBatch(payoutBatchId: string) {
    return this.#inner.getPayoutBatch(payoutBatchId);
  }
  listDisputesForTransaction(transactionId: string) {
    return this.#inner.listDisputesForTransaction(transactionId);
  }
  verifyWebhookSignature(input: WebhookVerificationInput) {
    return this.#inner.verifyWebhookSignature(input);
  }
}
