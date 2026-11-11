// Carrying out payment operations against PayPal, safely.
//
// The rules this file exists to enforce:
//
//   1. Intent is written before the call. The operation is moved to
//      "submitting" and an attempt row is committed BEFORE PayPal is called.
//      If the process dies at any point, the database shows a call was in
//      flight, and the operation is treated as "outcome unknown".
//
//   2. One key, for ever. Every call for an operation carries the same
//      PayPal-Request-Id. PayPal answers a repeated key with the first result
//      and does not move money again.
//
//   3. A timeout is not a failure. A timeout, a dropped connection or a 5xx
//      moves the operation to "unknown". It leaves "unknown" only by asking
//      PayPal what happened.
//
//   4. No call is made while holding a database transaction. Claim, call,
//      record: three steps, two short transactions.

import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import { HOUR, MINUTE, SECOND } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { backoffMs, enqueue, RetryLater, type Job, type JobHandler } from "../../platform/jobs/queue.ts";
import { fromMinor, toMinor } from "../../platform/money.ts";
import {
  classifyRefundRejection,
  ProviderError,
  type PayPalProvider,
  type ProviderPayoutBatch,
  type ProviderRefund,
} from "../paypal/provider.ts";
import { finishBatchIfDone, pauseBatch } from "./batches.ts";
import { assertTransition, type OperationState } from "./state.ts";

export type ProviderResolver = (orgId: string, connectionId: string) => Promise<PayPalProvider>;

export type ExecutorDeps = {
  db: Db;
  clock: Clock;
  providers: ProviderResolver;
  /** How long a "submitting" operation may sit before it is presumed abandoned. Must exceed the provider timeout. */
  staleSubmittingMs?: number;
  /** After this long in "unknown", stop replaying automatically and ask a person. */
  replayHorizonMs?: number;
};

type Operation = {
  id: string; org_id: string; batch_id: string; candidate_id: string; kind: "refund" | "payout";
  paypal_connection_id: string; capture_id: string | null; recipient_type: "EMAIL" | "PAYPAL_ID" | null;
  recipient: string | null; currency: string; amount_minor: number; state: OperationState; idempotency_key: string;
  provider_refund_id: string | null; provider_payout_batch_id: string | null; provider_payout_item_id: string | null;
  attempts: number; next_attempt_at: Date | null; updated_at: Date;
};

const OP_COLUMNS = `id, org_id, batch_id, candidate_id, kind, paypal_connection_id, capture_id, recipient_type, recipient,
  trim(currency) as currency, amount_minor, state, idempotency_key, provider_refund_id, provider_payout_batch_id,
  provider_payout_item_id, attempts, next_attempt_at, updated_at`;

type Submitted = { kind: "refund"; refund: ProviderRefund } | { kind: "payout"; batch: ProviderPayoutBatch };
type Outcome = { ok: true; result: Submitted } | { ok: false; error: unknown };

const PAYOUT_FAILED = new Set(["FAILED", "BLOCKED", "RETURNED", "REFUNDED", "REVERSED"]);

export class OperationExecutor {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #providers: ProviderResolver;
  readonly #staleSubmittingMs: number;
  readonly #replayHorizonMs: number;

  constructor(deps: ExecutorDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#providers = deps.providers;
    this.#staleSubmittingMs = deps.staleSubmittingMs ?? 90 * SECOND;
    this.#replayHorizonMs = deps.replayHorizonMs ?? 6 * HOUR;
  }

  handlers(): Record<string, JobHandler> {
    const id = (job: Job) => String(job.payload.operationId);
    return {
      "operation.execute": (job) => this.execute(id(job)),
      "operation.reconcile": (job) => this.reconcile(id(job)),
      "operations.sweep": () => this.sweep().then(() => undefined),
    };
  }

  // ---------- helpers ----------

  async #lock(tx: Queryable, operationId: string): Promise<Operation | null> {
    const rows = await tx.query<Operation>(`select ${OP_COLUMNS} from payment_operations where id = $1 for update`, [operationId]);
    return rows[0] ?? null;
  }

  async #move(
    tx: Queryable,
    op: Operation,
    to: OperationState,
    fields: Record<string, unknown>,
    why: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    assertTransition(op.state, to);
    const terminal = to === "succeeded" || to === "failed_final" || to === "cancelled";
    const columns = Object.keys(fields);
    const sets = columns.map((c, i) => `${c} = $${i + 5}`).join(", ");
    await tx.query(
      `update payment_operations
          set state = $2, updated_at = $3, completed_at = case when $4::boolean then $3 else completed_at end
              ${sets ? `, ${sets}` : ""}
        where id = $1`,
      [op.id, to, now.toISOString(), terminal, ...columns.map((c) => fields[c])],
    );
    await audit(tx, {
      orgId: op.org_id, actor: { kind: "system" }, action: `operation.${to}`, entityType: "payment_operation",
      entityId: op.id, data: { from: op.state, batchId: op.batch_id, ...why }, at: now,
    });
    op.state = to;
  }

  async #scheduleReconcile(tx: Queryable, op: Operation, delayMs: number, now: Date): Promise<void> {
    await enqueue(tx, {
      type: "operation.reconcile", orgId: op.org_id, payload: { operationId: op.id },
      runAt: new Date(now.getTime() + delayMs), dedupeKey: `operation.reconcile:${op.id}`, maxAttempts: 50,
    }, now);
  }

  async #openAttempt(tx: Queryable, op: Operation, purpose: "submit" | "reconcile", now: Date): Promise<number> {
    const attemptNo = op.attempts + 1;
    await tx.query("update payment_operations set attempts = $2, updated_at = $3 where id = $1", [op.id, attemptNo, now.toISOString()]);
    await tx.query(
      `insert into provider_attempts (org_id, operation_id, attempt_no, purpose, request_id, started_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [op.org_id, op.id, attemptNo, purpose, op.idempotency_key, now.toISOString()],
    );
    op.attempts = attemptNo;
    return attemptNo;
  }

  async #closeAttempt(tx: Queryable, op: Operation, attemptNo: number, outcome: string, detail: {
    httpStatus?: number | null; debugId?: string | null; errorCode?: string | null; response?: unknown;
  }, now: Date): Promise<void> {
    await tx.query(
      `update provider_attempts set outcome = $4, http_status = $5, debug_id = $6, error_code = $7, response = $8::jsonb, finished_at = $9
        where org_id = $1 and operation_id = $2 and attempt_no = $3`,
      [op.org_id, op.id, attemptNo, outcome, detail.httpStatus ?? null, detail.debugId ?? null, detail.errorCode ?? null, json(detail.response ?? null), now.toISOString()],
    );
  }

  async #reconciliationItem(tx: Queryable, op: Operation, item: {
    kind: string; severity: "info" | "warning" | "critical"; expected?: unknown; actual?: unknown; resolution?: string;
  }, now: Date): Promise<void> {
    const [run] = await tx.query<{ id: string }>(
      "insert into reconciliation_runs (org_id, scope, started_at, finished_at) values ($1, $2, $3, $3) returning id",
      [op.org_id, `operation:${op.id}`, now.toISOString()],
    );
    await tx.query(
      `insert into reconciliation_items (org_id, run_id, operation_id, kind, severity, expected, actual, status, resolution, created_at, resolved_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
      [
        op.org_id, run!.id, op.id, item.kind, item.severity, json(item.expected ?? null), json(item.actual ?? null),
        item.resolution ? "resolved" : "open", item.resolution ?? null, now.toISOString(), item.resolution ? now.toISOString() : null,
      ],
    );
  }

  /** Sends the request to PayPal. The only place money is asked to move. */
  async #submit(provider: PayPalProvider, op: Operation): Promise<Submitted> {
    const amount = { currency_code: op.currency, value: fromMinor(op.amount_minor, op.currency) };
    if (op.kind === "refund") {
      const refund = await provider.refundCapture(op.capture_id!, {
        requestId: op.idempotency_key,
        amount,
        customId: op.idempotency_key, // lets us find this refund in PayPal's records later
        noteToPayer: "Refund from the merchant.",
      });
      return { kind: "refund", refund };
    }
    let batch = await provider.createPayout({
      senderBatchId: op.idempotency_key,
      emailSubject: "You have received a payment",
      items: [{ senderItemId: op.id, recipientType: op.recipient_type!, receiver: op.recipient!, amount, note: "Compensation from the merchant." }],
    });
    if (batch.items.length === 0 && batch.payout_batch_id) batch = await provider.getPayoutBatch(batch.payout_batch_id);
    return { kind: "payout", batch };
  }

  // ---------- recording what PayPal said ----------

  async #applyRefund(tx: Queryable, op: Operation, refund: ProviderRefund, now: Date): Promise<OperationState> {
    let providerMinor: number | null = null;
    try {
      providerMinor = toMinor(refund.amount.value, refund.amount.currency_code);
    } catch {
      providerMinor = null;
    }
    if (providerMinor !== op.amount_minor || refund.amount.currency_code !== op.currency) {
      await this.#reconciliationItem(tx, op, {
        kind: "amount_mismatch", severity: "critical",
        expected: { amountMinor: op.amount_minor, currency: op.currency }, actual: refund.amount,
      }, now);
    }
    const to: OperationState = refund.status === "COMPLETED" ? "succeeded" : refund.status === "PENDING" ? "pending_provider" : "failed_final";
    await this.#move(tx, op, to, {
      provider_refund_id: refund.id, provider_status: refund.status, provider_amount_minor: providerMinor,
      failure_code: to === "failed_final" ? `REFUND_${refund.status}` : null,
      failure_message: to === "failed_final" ? `PayPal created the refund but reports it as ${refund.status}.` : null,
    }, { providerRefundId: refund.id, providerStatus: refund.status }, now);

    if (to !== "failed_final") {
      // Keep our copy of PayPal's ledger in step, so the next calculation sees this refund at once.
      const [conn] = await tx.query<{ environment: string }>("select environment from paypal_connections where id = $1", [op.paypal_connection_id]);
      await tx.query(
        `insert into payment_transactions
           (org_id, paypal_connection_id, environment, transaction_id, kind, event_code, provider_status, occurred_at, currency,
            gross_minor, custom_id, reference_transaction_id, source, raw, last_synced_at)
         values ($1,$2,$3,$4,'refund','T1107',$5,$6,$7,$8,$9,$10,'api_lookup',$11::jsonb,$12)
         on conflict (org_id, provider, environment, transaction_id) do update set provider_status = excluded.provider_status, last_synced_at = excluded.last_synced_at`,
        [op.org_id, op.paypal_connection_id, conn!.environment, refund.id, refund.status === "PENDING" ? "P" : "S",
         refund.create_time ?? now.toISOString(), op.currency, op.amount_minor, op.idempotency_key, op.capture_id, json(refund), now.toISOString()],
      );
      let total: number | null = null;
      try {
        total = refund.total_refunded_amount ? toMinor(refund.total_refunded_amount.value, refund.total_refunded_amount.currency_code) : null;
      } catch {
        total = null;
      }
      await tx.query(
        `update payment_transactions
            set refunded_minor = least(gross_minor, greatest(refunded_minor, coalesce($4::bigint, refunded_minor + $5)))
          where org_id = $1 and environment = $2 and transaction_id = $3 and kind = 'payment'`,
        [op.org_id, conn!.environment, op.capture_id, total, op.amount_minor],
      );
    }
    return to;
  }

  async #applyPayout(tx: Queryable, op: Operation, batch: ProviderPayoutBatch, now: Date): Promise<OperationState> {
    const item = batch.items.find((i) => i.sender_item_id === op.id) ?? batch.items[0];
    const batchDead = batch.batch_status === "DENIED" || batch.batch_status === "CANCELED";
    let to: OperationState;
    if (item?.transaction_status === "SUCCESS") to = "succeeded";
    else if (batchDead || (item && PAYOUT_FAILED.has(item.transaction_status))) to = "failed_final";
    else to = "pending_provider";
    if (to === "succeeded" && !item?.payout_item_id) to = "pending_provider";
    await this.#move(tx, op, to, {
      provider_payout_batch_id: batch.payout_batch_id, provider_payout_item_id: item?.payout_item_id ?? null,
      provider_status: item?.transaction_status ?? batch.batch_status, provider_amount_minor: op.amount_minor,
      failure_code: to === "failed_final" ? item?.error_name ?? `PAYOUT_${item?.transaction_status ?? batch.batch_status}` : null,
      failure_message: to === "failed_final" ? item?.error_message ?? `PayPal reports the payout as ${item?.transaction_status ?? batch.batch_status}.` : null,
    }, { payoutBatchId: batch.payout_batch_id, payoutItemId: item?.payout_item_id ?? null, providerStatus: item?.transaction_status ?? batch.batch_status }, now);
    return to;
  }

  async #applyOutcome(operationId: string, attemptNo: number, purpose: "submit" | "reconcile", outcome: Outcome): Promise<{ retryInMs: number | null }> {
    const now = this.#clock.now();
    return this.#db.tx(async (tx) => {
      const op = await this.#lock(tx, operationId);
      if (!op) return { retryInMs: null };
      const stillOurs = op.state === "submitting" || op.state === "unknown";

      if (outcome.ok) {
        await this.#closeAttempt(tx, op, attemptNo, "accepted", { httpStatus: 200, response: outcome.result }, now);
        if (!stillOurs) return { retryInMs: null }; // settled meanwhile (for example by a webhook); the record above is enough
        const wasUnknown = op.state === "unknown";
        const to = outcome.result.kind === "refund"
          ? await this.#applyRefund(tx, op, outcome.result.refund, now)
          : await this.#applyPayout(tx, op, outcome.result.batch, now);
        if (wasUnknown) {
          await this.#reconciliationItem(tx, op, {
            kind: "unknown_resolved_succeeded", severity: "info", actual: outcome.result,
            resolution: `PayPal answered the repeated request (same request ID). The operation is now ${to}. No second payment was made.`,
          }, now);
        }
        if (to === "pending_provider") await this.#scheduleReconcile(tx, op, MINUTE, now);
        await finishBatchIfDone(tx, op.org_id, op.batch_id, now);
        return { retryInMs: null };
      }

      const error = outcome.error;
      if (!(error instanceof ProviderError)) {
        // Something broke on our side around the call. We cannot know whether PayPal acted.
        await this.#closeAttempt(tx, op, attemptNo, "network_error", { errorCode: "INTERNAL", response: { message: String(error) } }, now);
        if (op.state === "submitting") {
          await this.#move(tx, op, "unknown", { failure_code: "INTERNAL", failure_message: "An internal error interrupted the request." }, { error: String(error) }, now);
          await this.#scheduleReconcile(tx, op, 30 * SECOND, now);
        }
        return { retryInMs: op.state === "unknown" ? backoffMs(op.attempts) : null };
      }

      const detail = { httpStatus: error.httpStatus, debugId: error.debugId, errorCode: error.issue, response: error.body ?? { message: error.message } };
      if (error.outcomeUnknown) {
        await this.#closeAttempt(tx, op, attemptNo, error.kind, detail, now);
        if (op.state === "submitting") {
          await this.#move(tx, op, "unknown", { failure_code: error.kind.toUpperCase(), failure_message: error.message }, { reason: error.kind }, now);
          await this.#scheduleReconcile(tx, op, 30 * SECOND, now);
          return { retryInMs: null };
        }
        return { retryInMs: backoffMs(op.attempts) }; // still unknown: ask again later
      }

      if (error.kind === "rate_limited") {
        await this.#closeAttempt(tx, op, attemptNo, "rate_limited", detail, now);
        const wait = error.retryAfterMs ?? 5 * SECOND;
        if (op.state === "submitting") {
          // PayPal did not process the request. Back to the queue, after the wait it asked for.
          await this.#move(tx, op, "queued", { next_attempt_at: new Date(now.getTime() + wait).toISOString() }, { reason: "rate_limited", waitMs: wait }, now);
          await enqueue(tx, {
            type: "operation.execute", orgId: op.org_id, payload: { operationId: op.id },
            runAt: new Date(now.getTime() + wait), dedupeKey: `operation.execute:${op.id}:${op.attempts}`,
          }, now);
          return { retryInMs: null };
        }
        return { retryInMs: wait };
      }

      if (error.kind === "auth_error") {
        await this.#closeAttempt(tx, op, attemptNo, "auth_error", detail, now);
        await this.#move(tx, op, "failed_retryable", { failure_code: error.issue ?? "AUTH", failure_message: "PayPal rejected the credentials or permissions." }, { reason: "auth_error" }, now);
        await pauseBatch(tx, { orgId: op.org_id, batchId: op.batch_id, reason: "PayPal rejected the credentials or permissions. Reconnect PayPal, then resume.", actor: { kind: "system" }, now });
        return { retryInMs: null };
      }

      // PayPal understood the request and refused it. The outcome is known: nothing was paid.
      await this.#closeAttempt(tx, op, attemptNo, "rejected", detail, now);
      const insufficient = error.issue === "INSUFFICIENT_FUNDS" || error.issue === "REFUND_FAILED_INSUFFICIENT_FUNDS";
      const verdict = op.kind === "refund" && !insufficient
        ? classifyRefundRejection(error.issue)
        : insufficient
          ? { policy: "needs_merchant" as const, meaning: "The PayPal balance is too low. Add funds, then resume.", pauseBatch: true }
          : { policy: "final" as const, meaning: `PayPal refused the ${op.kind}${error.issue ? ` (${error.issue})` : ""}.` };
      const wasUnknown = op.state === "unknown";
      await this.#move(tx, op, verdict.policy === "final" ? "failed_final" : "failed_retryable",
        { failure_code: error.issue ?? "REJECTED", failure_message: verdict.meaning }, { issue: error.issue, debugId: error.debugId }, now);
      if (wasUnknown) {
        await this.#reconciliationItem(tx, op, {
          kind: "unknown_resolved_not_found", severity: "info", actual: { issue: error.issue },
          resolution: `The first request did not take effect at PayPal. The repeated request was refused: ${verdict.meaning}`,
        }, now);
      }
      if (verdict.policy === "needs_merchant" && verdict.pauseBatch) {
        await pauseBatch(tx, { orgId: op.org_id, batchId: op.batch_id, reason: verdict.meaning, actor: { kind: "system" }, now });
      }
      await finishBatchIfDone(tx, op.org_id, op.batch_id, now);
      return { retryInMs: null };
    });
  }

  // ---------- job: execute ----------

  async execute(operationId: string): Promise<void> {
    const now = this.#clock.now();
    const claimed = await this.#db.tx(async (tx): Promise<{ op: Operation; attemptNo: number } | null> => {
      const op = await this.#lock(tx, operationId);
      if (!op) return null;
      if (op.state === "submitting") {
        // Either another worker is in the middle of the call, or one died there.
        const age = now.getTime() - new Date(op.updated_at).getTime();
        if (age < this.#staleSubmittingMs) throw new RetryLater(this.#staleSubmittingMs - age + SECOND, "the operation is being submitted");
        await this.#move(tx, op, "unknown", { failure_code: "WORKER_STOPPED", failure_message: "A worker stopped while this request was in flight." }, { reason: "worker_stopped" }, now);
        await this.#scheduleReconcile(tx, op, 0, now);
        return null;
      }
      if (op.state !== "queued") return null; // already handled; the job is a repeat
      const [batch] = await tx.query<{ status: string }>("select status from batches where org_id = $1 and id = $2", [op.org_id, op.batch_id]);
      if (batch?.status === "paused") return null; // resuming the batch queues it again
      if (batch?.status !== "executing") {
        await this.#move(tx, op, "cancelled", {}, { reason: `batch is ${batch?.status ?? "missing"}` }, now);
        return null;
      }
      if (op.next_attempt_at && new Date(op.next_attempt_at) > now) {
        throw new RetryLater(new Date(op.next_attempt_at).getTime() - now.getTime(), "waiting for the rate limit");
      }
      await this.#move(tx, op, "submitting", {}, { requestId: op.idempotency_key }, now);
      const attemptNo = await this.#openAttempt(tx, op, "submit", now);
      return { op, attemptNo };
    });
    if (!claimed) return;

    let outcome: Outcome;
    try {
      const provider = await this.#providers(claimed.op.org_id, claimed.op.paypal_connection_id);
      outcome = { ok: true, result: await this.#submit(provider, claimed.op) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await this.#applyOutcome(claimed.op.id, claimed.attemptNo, "submit", outcome);
  }

  // ---------- job: reconcile ----------

  async reconcile(operationId: string): Promise<void> {
    const now = this.#clock.now();
    const rows = await this.#db.query<Operation>(`select ${OP_COLUMNS} from payment_operations where id = $1`, [operationId]);
    const op = rows[0];
    if (!op) return;
    if (op.state === "pending_provider") return this.#pollPending(op);
    if (op.state !== "unknown") return;

    // 1. PayPal's own records, as we last copied them, may already show the refund.
    if (op.kind === "refund") {
      const seen = await this.#db.query<{ transaction_id: string; provider_status: string | null }>(
        "select transaction_id, provider_status from payment_transactions where org_id = $1 and kind = 'refund' and custom_id = $2 limit 1",
        [op.org_id, op.idempotency_key],
      );
      if (seen[0]) {
        await this.#db.tx(async (tx) => {
          const locked = await this.#lock(tx, op.id);
          if (!locked || locked.state !== "unknown") return;
          await this.#move(tx, locked, "succeeded", { provider_refund_id: seen[0]!.transaction_id, provider_status: "COMPLETED", provider_amount_minor: locked.amount_minor },
            { source: "ledger", providerRefundId: seen[0]!.transaction_id }, now);
          await this.#reconciliationItem(tx, locked, {
            kind: "unknown_resolved_succeeded", severity: "info", actual: seen[0],
            resolution: "PayPal's transaction records show this refund. No request was repeated.",
          }, now);
          await finishBatchIfDone(tx, locked.org_id, locked.batch_id, now);
        });
        return;
      }
    }

    // 2. Repeating the request is only right if the batch still stands and the request is recent.
    const [batch] = await this.#db.query<{ status: string }>("select status from batches where org_id = $1 and id = $2", [op.org_id, op.batch_id]);
    const batchStands = batch !== undefined && ["executing", "paused", "completed", "completed_with_failures"].includes(batch.status);
    const tooOld = now.getTime() - new Date(op.updated_at).getTime() > this.#replayHorizonMs;
    if (!batchStands || tooOld) {
      const already = await this.#db.query(
        "select 1 from reconciliation_items where org_id = $1 and operation_id = $2 and kind = 'still_pending' and status = 'open'",
        [op.org_id, op.id],
      );
      if (already.length === 0) {
        await this.#db.tx((tx) => this.#reconciliationItem(tx, op, {
          kind: "still_pending", severity: "critical",
          expected: { amountMinor: op.amount_minor, currency: op.currency, captureId: op.capture_id, requestId: op.idempotency_key },
          actual: { reason: batchStands ? "outcome unknown for too long to repeat automatically" : `the batch is ${batch?.status}` },
        }, now));
      }
      throw new RetryLater(15 * MINUTE, "waiting for PayPal's records to show the outcome");
    }

    // 3. Ask PayPal by repeating the request with the same key.
    const attemptNo = await this.#db.tx(async (tx) => {
      const locked = await this.#lock(tx, op.id);
      if (!locked || locked.state !== "unknown") return null;
      return this.#openAttempt(tx, locked, "reconcile", now);
    });
    if (attemptNo === null) return;

    let outcome: Outcome;
    try {
      const provider = await this.#providers(op.org_id, op.paypal_connection_id);
      try {
        outcome = { ok: true, result: await this.#submit(provider, op) };
      } catch (error) {
        const original = op.kind === "payout" ? originalPayoutId(error) : null;
        // PayPal refuses a repeated sender_batch_id and points at the original payout: that is our answer.
        if (original) outcome = { ok: true, result: { kind: "payout", batch: await provider.getPayoutBatch(original) } };
        else throw error;
      }
    } catch (error) {
      outcome = { ok: false, error };
    }
    const { retryInMs } = await this.#applyOutcome(op.id, attemptNo, "reconcile", outcome);
    if (retryInMs !== null) throw new RetryLater(retryInMs, "the outcome is still unknown");
  }

  async #pollPending(op: Operation): Promise<void> {
    const now = this.#clock.now();
    const provider = await this.#providers(op.org_id, op.paypal_connection_id);
    const result: Submitted | null =
      op.kind === "refund" && op.provider_refund_id
        ? { kind: "refund", refund: await provider.getRefund(op.provider_refund_id) }
        : op.kind === "payout" && op.provider_payout_batch_id
          ? { kind: "payout", batch: await provider.getPayoutBatch(op.provider_payout_batch_id) }
          : null;
    if (!result) return;
    const settled = await this.#db.tx(async (tx) => {
      const locked = await this.#lock(tx, op.id);
      if (!locked || locked.state !== "pending_provider") return true;
      if (result.kind === "refund") {
        const status = result.refund.status;
        if (status === "PENDING") return false;
        if (status === "COMPLETED") {
          await this.#move(tx, locked, "succeeded", { provider_status: status }, { providerStatus: status }, now);
          await tx.query("update payment_transactions set provider_status = 'S' where org_id = $1 and transaction_id = $2 and kind = 'refund'", [locked.org_id, result.refund.id]);
        } else {
          await this.#move(tx, locked, "failed_final", { provider_status: status, failure_code: `REFUND_${status}`, failure_message: `PayPal reports the refund as ${status}.` }, { providerStatus: status }, now);
          // The refund did not happen after all: take it back out of our copy of the ledger.
          await tx.query("update payment_transactions set provider_status = 'D' where org_id = $1 and transaction_id = $2 and kind = 'refund'", [locked.org_id, result.refund.id]);
          await tx.query(
            `update payment_transactions set refunded_minor = greatest(0, refunded_minor - $3)
              where org_id = $1 and transaction_id = $2 and kind = 'payment'`,
            [locked.org_id, locked.capture_id, locked.amount_minor],
          );
        }
      } else {
        const item = result.batch.items.find((i) => i.sender_item_id === locked.id) ?? result.batch.items[0];
        const dead = result.batch.batch_status === "DENIED" || result.batch.batch_status === "CANCELED";
        if (item?.transaction_status === "SUCCESS") {
          await this.#move(tx, locked, "succeeded", { provider_status: "SUCCESS", provider_payout_item_id: item.payout_item_id }, { providerStatus: "SUCCESS" }, now);
        } else if (dead || (item && PAYOUT_FAILED.has(item.transaction_status))) {
          const status = item?.transaction_status ?? result.batch.batch_status;
          await this.#move(tx, locked, "failed_final", { provider_status: status, failure_code: item?.error_name ?? `PAYOUT_${status}`, failure_message: item?.error_message ?? `PayPal reports the payout as ${status}.` }, { providerStatus: status }, now);
        } else {
          return false;
        }
      }
      await finishBatchIfDone(tx, locked.org_id, locked.batch_id, now);
      return true;
    });
    if (!settled) {
      const age = now.getTime() - new Date(op.updated_at).getTime();
      throw new RetryLater(Math.min(HOUR, Math.max(MINUTE, age)), "PayPal still reports the operation as pending");
    }
  }

  // ---------- job: sweep ----------

  /** Finds operations that were left in flight by a stopped worker, and makes sure each has a reconcile job. */
  async sweep(): Promise<{ abandoned: number; requeued: number }> {
    const now = this.#clock.now();
    const cutoff = new Date(now.getTime() - this.#staleSubmittingMs).toISOString();
    return this.#db.tx(async (tx) => {
      const stale = await tx.query<Operation>(
        `select ${OP_COLUMNS} from payment_operations where state = 'submitting' and updated_at < $1 for update skip locked`,
        [cutoff],
      );
      for (const op of stale) {
        await this.#move(tx, op, "unknown", { failure_code: "WORKER_STOPPED", failure_message: "A worker stopped while this request was in flight." }, { reason: "sweep" }, now);
      }
      const waiting = await tx.query<Operation>(
        `select ${OP_COLUMNS} from payment_operations where state in ('unknown', 'pending_provider')`,
      );
      let requeued = 0;
      for (const op of waiting) {
        const id = await enqueue(tx, {
          type: "operation.reconcile", orgId: op.org_id, payload: { operationId: op.id },
          dedupeKey: `operation.reconcile:${op.id}`, maxAttempts: 50,
        }, now);
        if (id) requeued++;
      }
      return { abandoned: stale.length, requeued };
    });
  }
}

/** The payout batch ID from PayPal's "duplicate sender_batch_id" refusal, which links to the original payout. */
function originalPayoutId(error: unknown): string | null {
  if (!(error instanceof ProviderError) || error.kind !== "rejected") return null;
  const links = (error.body as { links?: Array<{ href?: string }> } | undefined)?.links;
  for (const link of Array.isArray(links) ? links : []) {
    const match = /\/v1\/payments\/payouts\/([A-Za-z0-9_-]+)/.exec(link.href ?? "");
    if (match) return match[1]!;
  }
  return null;
}
