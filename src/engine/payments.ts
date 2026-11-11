// Step 3: move the money, safely.
//  - Nothing is sent until a person approves the batch.
//  - Every item's request ID is stored BEFORE the PayPal call, so a retry can never pay twice.
//  - Nothing is marked paid until PayPal's own record says so (read-back after every call).
//  - A payment older than PayPal's refund window, or made outside PayPal, goes by payout instead.
import { EventEmitter } from "node:events";
import { REFUND_WINDOW_DAYS } from "../config.ts";
import { all, get, logEvent, newId, now, run, tx } from "../db.ts";
import { fmt, usd } from "../money.ts";
import { paypal, PayPalError } from "../paypal/index.ts";
import type { AffectedRow } from "./match.ts";

export interface Batch {
  id: string;
  incident_id: string;
  label: string;
  total_cents: number;
  item_count: number;
  state: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}
export interface PaymentItem {
  id: string;
  batch_id: string;
  incident_id: string;
  affected_id: string;
  kind: "refund" | "payout";
  capture_id: string | null;
  email: string | null;
  amount_cents: number;
  currency: string;
  request_id: string;
  paypal_id: string | null;
  state: string;
  error: string | null;
  updated_at: string;
}

const PAYOUT_FEE_CENTS = 25; // PayPal's flat fee per payout through the API in the US (fees page, Nov 2026)
export const events = new EventEmitter();
events.setMaxListeners(100);
const emit = (batchId: string, type: string, data: unknown) => events.emit(batchId, { type, data });

const ageDays = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 86400_000 : 0);

/** Queue the given customers (or everyone ready or confirmed) into a draft batch. */
export function createBatch(incidentId: string, label: string, affectedIds?: string[]): { batch: Batch; preview: BatchPreview } {
  const eligible = all<AffectedRow>("SELECT * FROM affected WHERE incident_id = ? AND state IN ('ready','confirmed') ORDER BY level, paid_at", incidentId).filter(
    (a) => !affectedIds || affectedIds.includes(a.id),
  );
  if (eligible.length === 0) throw new Error("No customers are ready to be paid.");
  const batchId = newId("b");
  tx(() => {
    run("INSERT INTO batch (id, incident_id, label, total_cents, item_count, created_at) VALUES (?,?,?,?,?,?)", batchId, incidentId, label, eligible.reduce((s, a) => s + a.owed_cents, 0), eligible.length, now());
    for (const a of eligible) {
      // Route: refund to the original payment when PayPal allows it, otherwise payout by email.
      const refundable = a.txn_id !== null && ageDays(a.paid_at) <= REFUND_WINDOW_DAYS;
      const kind = refundable ? "refund" : "payout";
      run(
        "INSERT INTO payment_item (id, batch_id, incident_id, affected_id, kind, capture_id, email, amount_cents, request_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        newId("pi"), batchId, incidentId, a.id, kind, refundable ? a.txn_id : null, a.email, a.owed_cents, `mg-${incidentId}-${a.id}-${kind}`, now(),
      );
      run("UPDATE affected SET state = 'queued' WHERE id = ?", a.id);
    }
  });
  logEvent(incidentId, "person", "batch-created", `Batch "${label}" drafted with ${eligible.length} customers.`);
  return { batch: getBatch(batchId)!, preview: previewBatch(batchId) };
}

export interface BatchPreview {
  refunds: { count: number; cents: number };
  payouts: { count: number; cents: number; feeCents: number; reasons: Record<string, number> };
  totalCents: number;
  balanceCents: number | null;
  sample: Array<{ name: string | null; ref: string; level: number; kind: string; amount: string }>;
}

export function previewBatch(batchId: string): BatchPreview {
  const items = all<PaymentItem & { level: number; ref_key: string; customer_name: string | null; txn_id: string | null }>(
    "SELECT p.*, a.level, a.ref_key, a.customer_name, a.txn_id FROM payment_item p JOIN affected a ON a.id = p.affected_id WHERE p.batch_id = ?",
    batchId,
  );
  const refunds = items.filter((i) => i.kind === "refund");
  const payouts = items.filter((i) => i.kind === "payout");
  const reasons: Record<string, number> = {};
  for (const p of payouts) {
    const why = p.txn_id ? `Paid more than ${REFUND_WINDOW_DAYS} days ago` : "No PayPal payment to refund";
    reasons[why] = (reasons[why] ?? 0) + 1;
  }
  const sum = (xs: PaymentItem[]) => xs.reduce((s, i) => s + i.amount_cents, 0);
  return {
    refunds: { count: refunds.length, cents: sum(refunds) },
    payouts: { count: payouts.length, cents: sum(payouts), feeCents: payouts.length * PAYOUT_FEE_CENTS, reasons },
    totalCents: sum(items),
    balanceCents: null,
    sample: items.slice(0, 10).map((i) => ({ name: i.customer_name, ref: i.ref_key, level: i.level, kind: i.kind, amount: usd(i.amount_cents) })),
  };
}

export const getBatch = (id: string) => get<Batch>("SELECT * FROM batch WHERE id = ?", id);
export const listBatches = (incidentId: string) => all<Batch>("SELECT * FROM batch WHERE incident_id = ? ORDER BY created_at", incidentId);
export const listItems = (batchId: string) =>
  all<PaymentItem & { customer_name: string | null; ref_key: string; level: number }>(
    "SELECT p.*, a.customer_name, a.ref_key, a.level FROM payment_item p JOIN affected a ON a.id = p.affected_id WHERE p.batch_id = ? ORDER BY p.rowid",
    batchId,
  );

export function approveBatch(batchId: string, person: string): Batch {
  const b = getBatch(batchId);
  if (!b) throw new Error("Batch not found");
  if (b.state !== "draft") throw new Error(`This batch is already ${b.state}.`);
  run("UPDATE batch SET state = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", person, now(), batchId);
  logEvent(b.incident_id, "person", "batch-approved", `${person} approved batch "${b.label}": ${b.item_count} payments, ${usd(b.total_cents)}.`);
  return getBatch(batchId)!;
}

function setItem(item: PaymentItem, state: string, paypalId: string | null, error: string | null) {
  run("UPDATE payment_item SET state = ?, paypal_id = COALESCE(?, paypal_id), error = ?, updated_at = ? WHERE id = ?", state, paypalId, error, now(), item.id);
  const affectedState = state === "completed" ? "paid" : state === "failed" ? "failed" : "queued";
  run("UPDATE affected SET state = ? WHERE id = ?", affectedState, item.affected_id);
  emit(item.batch_id, "item", { id: item.id, state, paypalId, error });
}

const errorText = (err: unknown) => (err instanceof PayPalError ? err.issue : err instanceof Error ? err.message : String(err));

async function sendRefund(item: PaymentItem, note: string) {
  try {
    const refund = await paypal.refundCapture(item.capture_id!, item.request_id, { currency_code: item.currency, value: fmt(item.amount_cents) }, note);
    // Never trust the call's own answer: read PayPal's record back.
    const seen = await paypal.getRefund(refund.id);
    const state = seen.status === "COMPLETED" ? "completed" : seen.status === "PENDING" ? "pending" : "failed";
    setItem(item, state, seen.id, state === "failed" ? `PayPal shows the refund as ${seen.status}` : null);
  } catch (err) {
    setItem(item, "failed", null, errorText(err));
    logEvent(item.incident_id, "paypal", "refund-failed", `Refund of ${usd(item.amount_cents)} failed: ${errorText(err)}.`);
  }
}

async function sendPayouts(batch: Batch, items: PaymentItem[], subject: string) {
  if (items.length === 0) return;
  try {
    const result = await paypal.createPayout(`mg-${batch.id}`, items.map((i) => ({ sender_item_id: i.id, receiver: i.email!, amount: { currency_code: i.currency, value: fmt(i.amount_cents) }, note: subject })), subject);
    const seen = await paypal.getPayout(result.payout_batch_id);
    for (const i of items) {
      const p = seen.items.find((x) => x.sender_item_id === i.id);
      const st = p?.transaction_status;
      const state = st === "SUCCESS" ? "completed" : st === "UNCLAIMED" ? "unclaimed" : st === "PENDING" || st === "ONHOLD" ? "pending" : "failed";
      setItem(i, state, p?.payout_item_id ?? null, state === "failed" ? `PayPal shows the payout as ${st ?? "missing"}` : state === "unclaimed" ? "Waiting for the customer to claim it; returns to you after 30 days" : null);
    }
    logEvent(batch.incident_id, "paypal", "payout", `Payout batch ${seen.payout_batch_id} is ${seen.batch_status} at PayPal with ${seen.items.length} payments.`);
  } catch (err) {
    for (const i of items) setItem(i, "failed", null, errorText(err));
    logEvent(batch.incident_id, "paypal", "payout-failed", `Payout batch failed: ${errorText(err)}.`);
  }
}

const running = new Set<string>();

/** Send an approved batch. Safe to call again after a pause or a crash: finished items are skipped. */
export async function runBatch(batchId: string, note: string): Promise<Batch> {
  const batch = getBatch(batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.state === "done") throw new Error("This batch has already been sent. Nothing was sent again.");
  if (!["approved", "paused"].includes(batch.state)) throw new Error("A batch must be approved before it can run.");
  if (running.has(batchId)) throw new Error("This batch is already running.");
  running.add(batchId);
  try {
    run("UPDATE batch SET state = 'running' WHERE id = ?", batchId);
    emit(batchId, "state", { state: "running" });
    const todo = all<PaymentItem>("SELECT * FROM payment_item WHERE batch_id = ? AND state = 'queued' ORDER BY rowid", batchId);

    const balance = await paypal.getBalance("USD");
    const need = todo.reduce((s, i) => s + i.amount_cents, 0);
    if (balance !== null && balance < need) {
      run("UPDATE batch SET state = 'paused' WHERE id = ?", batchId);
      logEvent(batch.incident_id, "rule", "paused", `Paused before sending: the PayPal balance (${usd(balance)}) does not cover this batch (${usd(need)}).`);
      emit(batchId, "state", { state: "paused", reason: "PayPal balance too low" });
      return getBatch(batchId)!;
    }

    const refunds = todo.filter((i) => i.kind === "refund");
    let done = 0;
    let failed = 0;
    const queue = [...refunds];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        await sendRefund(item, note);
        done++;
        if (get<{ state: string }>("SELECT state FROM payment_item WHERE id = ?", item.id)!.state === "failed") failed++;
        // Stop early if PayPal is rejecting a lot: something is wrong with the batch, not one payment.
        if (failed >= 5 && failed / done > 0.05) queue.length = 0;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (done > 0) logEvent(batch.incident_id, "paypal", "refunds", `${done - failed} of ${done} refunds are confirmed in PayPal's own records${failed ? `; ${failed} failed` : ""}.`);

    const stoppedEarly = done < refunds.length;
    if (!stoppedEarly) await sendPayouts(batch, todo.filter((i) => i.kind === "payout"), note);

    const state = stoppedEarly ? "paused" : "done";
    run("UPDATE batch SET state = ? WHERE id = ?", state, batchId);
    if (stoppedEarly) logEvent(batch.incident_id, "rule", "paused", `Paused after ${failed} of ${done} refunds failed. Fix the cause, then resume.`);
    emit(batchId, "state", { state });
    return getBatch(batchId)!;
  } finally {
    running.delete(batchId);
  }
}

/** Move failed refunds that PayPal can no longer refund into a new draft batch of payouts. */
export function rerouteFailed(batchId: string): { batch: Batch; preview: BatchPreview } | null {
  const batch = getBatch(batchId);
  if (!batch) throw new Error("Batch not found");
  const failed = all<PaymentItem>("SELECT * FROM payment_item WHERE batch_id = ? AND kind = 'refund' AND state = 'failed' AND error = 'REFUND_TIME_LIMIT_EXCEEDED'", batchId);
  if (failed.length === 0) return null;
  const newBatch = newId("b");
  tx(() => {
    run("INSERT INTO batch (id, incident_id, label, total_cents, item_count, created_at) VALUES (?,?,?,?,?,?)", newBatch, batch.incident_id, `Payouts for payments too old to refund`, failed.reduce((s, i) => s + i.amount_cents, 0), failed.length, now());
    for (const f of failed) {
      run(
        "INSERT INTO payment_item (id, batch_id, incident_id, affected_id, kind, email, amount_cents, request_id, updated_at) VALUES (?,?,?,?,'payout',?,?,?,?)",
        newId("pi"), newBatch, f.incident_id, f.affected_id, f.email, f.amount_cents, `mg-${f.incident_id}-${f.affected_id}-payout`, now(),
      );
      run("UPDATE affected SET state = 'queued' WHERE id = ?", f.affected_id);
    }
  });
  logEvent(batch.incident_id, "rule", "rerouted", `${failed.length} refunds were too old for PayPal to refund; queued as payouts in a new batch that needs approval.`);
  return { batch: getBatch(newBatch)!, preview: previewBatch(newBatch) };
}
