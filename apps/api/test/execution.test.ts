// End-to-end tests of the money path against the simulated PayPal:
// store order -> PayPal payment -> sync -> incident -> match -> batch ->
// approval -> execution -> reconciliation. Every failure mode that could pay a
// customer twice, or lose track of a payment, has a test here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAuditChain } from "../src/platform/audit.ts";
import { HOUR, MINUTE } from "../src/platform/clock.ts";
import { enqueue } from "../src/platform/jobs/queue.ts";
import { cancelBatch, createBatch, decideBatch, previewBatch, resumeBatch, startBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { lookupPaymentsByReference } from "../src/modules/transactions/sync.ts";
import { scenario } from "./scenario.ts";

test("happy path: three affected customers are found, approved and refunded once each", async () => {
  const s = await scenario();
  const a = await s.sell();
  const b = await s.sell({ quantity: 2 });
  const other = await s.sell({ batchCode: "LOT-23A" });
  await s.sell({ sku: "KETTLE-1", batchCode: null });
  await s.sync();

  const incidentId = await s.incident();
  const result = await s.match(incidentId);
  assert.equal(result.autoConfirmed, 2, "two orders carry the affected batch code");
  assert.equal(result.stats.clearedByBatchRecord, 1, "one order is proven to be another batch");

  const preview = await previewBatch(s.db, s.orgId, incidentId);
  assert.equal(preview.totals.count, 2);
  assert.equal(preview.totals.byCurrency.USD!.amountMinor, 5900 + 11800);
  assert.equal(s.paypal.refunds.size, 0, "a preview moves no money");

  const { batchId } = await s.approvedBatch(incidentId);
  await s.settle();

  const ops = await s.operations(batchId);
  assert.deepEqual(ops.map((o) => o.state), ["succeeded", "succeeded"]);
  assert.ok(ops.every((o) => o.provider_refund_id?.startsWith("SIMREF")), "PayPal's refund ID is stored");
  assert.equal((await s.batchStatus(batchId)).status, "completed");
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900);
  assert.equal(s.paypal.captures.get(b.captureId!)!.refundedMinor, 11800);
  assert.equal(s.paypal.captures.get(other.captureId!)!.refundedMinor, 0, "the unaffected customer was not touched");

  const [ledger] = await s.db.query<{ refunded_minor: number }>(
    "select refunded_minor from payment_transactions where transaction_id = $1", [a.captureId],
  );
  assert.equal(ledger!.refunded_minor, 5900, "our copy of the ledger shows the refund");

  // Running everything again pays nobody twice.
  await s.match(incidentId);
  const again = await previewBatch(s.db, s.orgId, incidentId);
  assert.equal(again.totals.count, 0);
  await assert.rejects(createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "Again" }), /No confirmed customer/);
  assert.deepEqual(await verifyAuditChain(s.db, s.orgId).then((r) => r.ok), true);
});

test("the reply is lost after PayPal refunded: the outcome is unknown, then resolved without a second refund", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  s.paypal.failNext({ on: "refund", when: "after", kind: "timeout" });
  const { batchId } = await s.approvedBatch(incidentId);

  await s.runner.drain();
  let [op] = await s.operations(batchId);
  assert.equal(op!.state, "unknown", "a timeout is not treated as a failure");
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900, "PayPal did refund");
  assert.equal((await s.batchStatus(batchId)).status, "executing", "the batch is not finished while an outcome is unknown");

  await s.settle();
  [op] = await s.operations(batchId);
  assert.equal(op!.state, "succeeded");
  assert.equal(s.paypal.refunds.size, 1, "exactly one refund exists at PayPal");
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900);
  const requestIds = s.paypal.calls.filter((c) => c.op === "refund").map((c) => c.requestId);
  assert.equal(new Set(requestIds).size, 1, "every call used the same request ID");
  const items = await s.db.query<{ kind: string; status: string }>("select kind, status from reconciliation_items where operation_id = $1", [op!.id]);
  assert.deepEqual(items, [{ kind: "unknown_resolved_succeeded", status: "resolved" }]);
  assert.equal((await s.batchStatus(batchId)).status, "completed");
});

test("the request never reached PayPal: the retry makes the one refund", async () => {
  const s = await scenario();
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  s.paypal.failNext({ on: "refund", when: "before", kind: "network_error" });
  const { batchId } = await s.approvedBatch(incidentId);
  await s.runner.drain();
  assert.equal((await s.operations(batchId))[0]!.state, "unknown");
  assert.equal(s.paypal.refunds.size, 0);
  await s.settle();
  assert.equal((await s.operations(batchId))[0]!.state, "succeeded");
  assert.equal(s.paypal.refunds.size, 1);
});

test("PayPal answers 5xx three times in a row: still one refund", async () => {
  const s = await scenario();
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  s.paypal.failNext({ on: "refund", when: "after", kind: "server_error" });
  s.paypal.failNext({ on: "refund", when: "after", kind: "server_error", times: 2 });
  const { batchId } = await s.approvedBatch(incidentId);
  await s.settle();
  const [op] = await s.operations(batchId);
  assert.equal(op!.state, "succeeded");
  assert.equal(op!.attempts, 4);
  assert.equal(s.paypal.refunds.size, 1);
});

test("a worker dies mid-call: the operation is found, looked up and completed once", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId);
  const [op] = await s.operations(batchId);

  // Reproduce the state a crash leaves behind: intent committed, PayPal called, nothing recorded after.
  await s.db.query("update payment_operations set state = 'submitting', attempts = 1 where id = $1", [op!.id]);
  await s.db.query(
    "insert into provider_attempts (org_id, operation_id, attempt_no, purpose, request_id) values ($1, $2, 1, 'submit', $3)",
    [s.orgId, op!.id, op!.idempotency_key],
  );
  await s.paypal.refundCapture(a.captureId!, { requestId: op!.idempotency_key, amount: { currency_code: "USD", value: "59.00" } });
  await s.db.query("update jobs set status = 'succeeded' where type = 'operation.execute'"); // the job died with its worker

  // Too soon: another worker might still be in the call.
  assert.deepEqual(await s.executor.sweep(), { abandoned: 0, requeued: 0 });
  s.clock.advance(5 * MINUTE);
  assert.deepEqual(await s.executor.sweep(), { abandoned: 1, requeued: 1 });
  await s.settle();

  assert.equal((await s.operations(batchId))[0]!.state, "succeeded");
  assert.equal(s.paypal.refunds.size, 1, "the worker restart did not issue another refund");
  const [attempt] = await s.db.query<{ outcome: string | null }>("select outcome from provider_attempts where operation_id = $1 and attempt_no = 1", [op!.id]);
  assert.equal(attempt!.outcome, null, "the abandoned attempt stays on record as never answered");
});

test("the same job delivered twice, and two workers at once, still refund once", async () => {
  const s = await scenario();
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId);
  const [op] = await s.operations(batchId);
  await enqueue(s.db, { type: "operation.execute", orgId: s.orgId, payload: { operationId: op!.id }, dedupeKey: "duplicate-delivery" }, s.clock.now());
  // Two workers pick the operation up at the same moment. One submits; the other must stand back.
  const results = await Promise.allSettled([s.executor.execute(op!.id), s.executor.execute(op!.id)]);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => /being submitted/.test(String((r as PromiseRejectedResult).reason))));
  await s.settle();
  assert.equal((await s.operations(batchId))[0]!.state, "succeeded");
  assert.equal(s.paypal.refunds.size, 1);
});

test("a rate limit puts the operation back in the queue for later", async () => {
  const s = await scenario();
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  s.paypal.failNext({ on: "refund", when: "before", kind: "rate_limited" });
  const { batchId } = await s.approvedBatch(incidentId);
  await s.runner.drain();
  assert.equal((await s.operations(batchId))[0]!.state, "queued");
  assert.equal(s.paypal.refunds.size, 0);
  await s.settle();
  assert.equal((await s.operations(batchId))[0]!.state, "succeeded");
  assert.equal(s.paypal.refunds.size, 1);
});

test("not enough balance pauses the batch; after funds are added it resumes and finishes", async () => {
  const s = await scenario();
  await s.sell();
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  s.paypal.balanceMinor.set("USD", 6000); // enough for one refund of 59.00
  const { batchId } = await s.approvedBatch(incidentId);
  await s.settle();

  const states = (await s.operations(batchId)).map((o) => o.state).sort();
  assert.deepEqual(states, ["failed_retryable", "succeeded"]);
  const paused = await s.batchStatus(batchId);
  assert.equal(paused.status, "paused");
  assert.match(paused.paused_reason ?? "", /balance is too low/);

  s.paypal.balanceMinor.set("USD", 100000);
  await resumeBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  await s.settle();
  assert.deepEqual((await s.operations(batchId)).map((o) => o.state), ["succeeded", "succeeded"]);
  assert.equal((await s.batchStatus(batchId)).status, "completed");
  assert.equal(s.paypal.refunds.size, 2);
});

test("refused by PayPal: already refunded elsewhere, and a dispute opened after approval", async () => {
  const s = await scenario();
  const a = await s.sell();
  const b = await s.sell();
  const c = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId, false);
  // Between approval and execution: someone refunds A in the PayPal dashboard, and B's buyer opens a dispute.
  await s.paypal.refundCapture(a.captureId!, { requestId: "from-the-dashboard" });
  s.paypal.captures.get(b.captureId!)!.disputed = true;
  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  await s.settle();

  const ops = await s.operations(batchId);
  const by = (captureId: string | null) => ops.find((o) => o.capture_id === captureId)!;
  assert.equal(by(a.captureId).state, "failed_final");
  assert.equal(by(a.captureId).failure_code, "CAPTURE_FULLY_REFUNDED");
  assert.equal(by(b.captureId).state, "failed_final");
  assert.equal(by(b.captureId).failure_code, "TRANSACTION_DISPUTED");
  assert.equal(by(c.captureId).state, "succeeded");
  assert.equal((await s.batchStatus(batchId)).status, "completed_with_failures");
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900, "A was refunded once, by the dashboard");
});

test("a pending refund is followed until PayPal completes or fails it", async () => {
  const s = await scenario();
  const ok = await s.sell();
  const bad = await s.sell();
  await s.sync();
  s.paypal.captures.get(ok.captureId!)!.refundsPending = true;
  s.paypal.captures.get(bad.captureId!)!.refundsPending = true;
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId);
  await s.runner.drain();
  assert.deepEqual((await s.operations(batchId)).map((o) => o.state), ["pending_provider", "pending_provider"]);
  assert.equal((await s.batchStatus(batchId)).status, "executing");

  // PayPal completes one and fails the other.
  const refunds = [...s.paypal.refunds.values()];
  refunds.find((r) => r.captureId === ok.captureId)!.status = "COMPLETED";
  refunds.find((r) => r.captureId === bad.captureId)!.status = "FAILED";
  s.paypal.captures.get(bad.captureId!)!.refundedMinor = 0;
  await s.settle();

  const ops = await s.operations(batchId);
  assert.equal(ops.find((o) => o.capture_id === ok.captureId)!.state, "succeeded");
  assert.equal(ops.find((o) => o.capture_id === bad.captureId)!.state, "failed_final");
  const [ledger] = await s.db.query<{ refunded_minor: number }>("select refunded_minor from payment_transactions where transaction_id = $1", [bad.captureId]);
  assert.equal(ledger!.refunded_minor, 0, "the failed refund is taken back out of our ledger");
  assert.equal((await s.batchStatus(batchId)).status, "completed_with_failures");
});

test("approval rules: role, second person, and a batch that changed after submission", async () => {
  const s = await scenario({ dualControl: true });
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.approver, name: "B" });

  await assert.rejects(startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /cannot go from "draft" to "executing"/);
  await submitBatch(s.deps, { orgId: s.orgId, batchId, userId: s.approver });
  await assert.rejects(decideBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, role: "operator", decision: "approve" }), /cannot approve payments/);
  await assert.rejects(decideBatch(s.deps, { orgId: s.orgId, batchId, userId: s.approver, role: "finance_approver", decision: "approve" }), /second person/);

  // Someone edits an amount after submission. The approval must not carry over.
  await s.db.query("update payment_operations set amount_minor = amount_minor + 1 where batch_id = $1", [batchId]);
  const [owner] = await s.db.query<{ id: string }>("insert into users (email, email_normalized, name, password_hash) values ('o@k.test', 'o@k.test', 'Owner', 'x') returning id");
  await assert.rejects(decideBatch(s.deps, { orgId: s.orgId, batchId, userId: owner!.id, role: "owner", decision: "approve" }), /changed after it was submitted/);
  await s.db.query("update payment_operations set amount_minor = amount_minor - 1 where batch_id = $1", [batchId]);

  const decided = await decideBatch(s.deps, { orgId: s.orgId, batchId, userId: owner!.id, role: "owner", decision: "approve" });
  assert.equal(decided.status, "approved");
  await s.db.query("update payment_operations set amount_minor = amount_minor + 1 where batch_id = $1", [batchId]);
  await assert.rejects(startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /no longer match what was approved/);
  assert.equal(s.paypal.refunds.size, 0);
});

test("a rejected batch pays nobody, and its customers can go into a new batch", async () => {
  const s = await scenario();
  await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" });
  await submitBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  const decided = await decideBatch(s.deps, { orgId: s.orgId, batchId, userId: s.approver, role: "finance_approver", decision: "reject", comment: "wrong amount" });
  assert.equal(decided.status, "rejected");
  assert.deepEqual((await s.operations(batchId)).map((o) => o.state), ["cancelled"]);
  assert.equal((await previewBatch(s.db, s.orgId, incidentId)).totals.count, 1);
});

test("a customer cannot be in two live batches, and a capture cannot have two live refunds", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const first = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "First" });
  await assert.rejects(createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "Second" }), /No confirmed customer/);

  // Even a direct insert is refused by the database once the first is in flight.
  await s.db.query("update payment_operations set state = 'queued' where batch_id = $1", [first.id]);
  const [op] = await s.db.query<{ candidate_id: string; calculation_id: string; paypal_connection_id: string }>(
    "select candidate_id, calculation_id, paypal_connection_id from payment_operations where batch_id = $1", [first.id],
  );
  const [other] = await s.db.query<{ id: string }>(
    "insert into batches (org_id, incident_id, rule_version_id, name) select org_id, incident_id, rule_version_id, 'Rogue' from batches where id = $1 returning id", [first.id],
  );
  await assert.rejects(
    s.db.query(
      `insert into payment_operations (org_id, batch_id, candidate_id, calculation_id, kind, paypal_connection_id, capture_id, currency, amount_minor, state, idempotency_key)
       values ($1, $2, $3, $4, 'refund', $5, $6, 'USD', 5900, 'queued', 'rogue-key')`,
      [s.orgId, other!.id, op!.candidate_id, op!.calculation_id, op!.paypal_connection_id, a.captureId],
    ),
    /unique/i,
  );
});

test("cancelling a batch with an unknown outcome does not repeat the request; PayPal's records settle it", async () => {
  const s = await scenario();
  const a = await s.sell();
  const b = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  s.paypal.failNext({ on: "refund", when: "after", kind: "timeout" });
  const { batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" }).then(async ({ id }) => {
    await submitBatch(s.deps, { orgId: s.orgId, batchId: id, userId: s.operator });
    await decideBatch(s.deps, { orgId: s.orgId, batchId: id, userId: s.approver, role: "finance_approver", decision: "approve" });
    await startBatch(s.deps, { orgId: s.orgId, batchId: id, userId: s.operator, spacingMs: 60_000 });
    return { batchId: id };
  });
  await s.runner.drain(); // the first operation runs and its reply is lost; the second is not due yet
  const cancelled = await cancelBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  assert.deepEqual(cancelled, { cancelled: 1, stillLive: 1 });

  const refundCallsBefore = s.paypal.calls.filter((c) => c.op === "refund").length;
  await s.settle(HOUR);
  assert.equal(s.paypal.calls.filter((c) => c.op === "refund").length, refundCallsBefore, "no request was repeated for a cancelled batch");
  const ops = await s.operations(batchId);
  assert.deepEqual(ops.map((o) => o.state).sort(), ["cancelled", "unknown"]);
  const lost = ops.find((o) => o.state === "unknown")!;
  assert.ok([a.captureId, b.captureId].includes(lost.capture_id));
  const [open] = await s.db.query<{ severity: string }>("select severity from reconciliation_items where status = 'open'");
  assert.equal(open!.severity, "critical", "a person is told");

  // The next sync of PayPal's transactions shows the refund, which settles the question.
  await s.sync();
  await s.settle(HOUR);
  assert.equal((await s.operations(batchId)).find((o) => o.id === lost.id)!.state, "succeeded");
  assert.equal(s.paypal.refunds.size, 1);
});

test("payments older than 180 days are paid by payout, once, even when the reply is lost", async () => {
  const s = await scenario();
  const old = await s.sell({ placedAt: "2026-03-10T10:00:00.000Z", shippedAt: "2026-03-12T10:00:00.000Z" });
  await s.sync();
  const incidentId = await s.incident({ compensation: { type: "full_refund", allowPayout: true } });
  await s.match(incidentId);
  // A payout is a new payment to a person, not money going back the way it came. It is never
  // mixed into a refund batch: it needs a batch, and an approval, of its own.
  const asRefunds = await previewBatch(s.db, s.orgId, incidentId);
  assert.equal(asRefunds.totals.count, 0);
  assert.equal(asRefunds.notIncluded.payout_needs_its_own_approval, 1);
  const preview = await previewBatch(s.db, s.orgId, incidentId, { kind: "payout" });
  assert.equal(preview.items[0]!.kind, "payout");
  assert.equal(preview.items[0]!.recipientType, "PAYPAL_ID");

  s.paypal.failNext({ on: "payout", when: "after", kind: "timeout" });
  const { batchId } = await s.approvedBatch(incidentId, true, "payout");
  await s.settle();
  const [op] = await s.operations(batchId);
  assert.equal(op!.state, "succeeded");
  assert.ok(op!.provider_payout_item_id);
  assert.equal(s.paypal.payouts.size, 1, "one payout, not two");
  assert.equal(s.paypal.captures.get(old.captureId!)!.refundedMinor, 0, "the old payment itself is not refunded");
});

test("a payment made minutes ago is fetched by its ID, without waiting for transaction search", async () => {
  const s = await scenario();
  const a = await s.sell();
  const gone = await s.sell();
  s.paypal.captures.delete(gone.captureId!); // the store recorded an ID PayPal does not know
  const looked = await lookupPaymentsByReference(s.deps, { orgId: s.orgId, connectionId: s.connectionId, provider: s.paypal });
  assert.deepEqual({ looked: looked.looked, found: looked.found }, { looked: 2, found: 1 });
  assert.deepEqual(looked.notFound, [gone.captureId]);
  assert.equal(s.paypal.calls.filter((c) => c.op === "search").length, 0, "transaction search was not used");

  const incidentId = await s.incident();
  const result = await s.match(incidentId);
  assert.equal(result.autoConfirmed, 1, "the order whose payment was found can be paid");
  assert.equal(result.needConfirmation, 1, "the other is flagged: its payment could not be found");
  const { batchId } = await s.approvedBatch(incidentId);
  await s.settle();
  assert.deepEqual((await s.operations(batchId)).map((o) => o.state), ["succeeded"]);
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900);
  // Looking again fetches nothing new.
  assert.equal((await lookupPaymentsByReference(s.deps, { orgId: s.orgId, connectionId: s.connectionId, provider: s.paypal })).found, 0);
});

test("without payouts allowed, an old payment is left for a person and is not in the batch", async () => {
  const s = await scenario();
  await s.sell({ placedAt: "2026-03-10T10:00:00.000Z", shippedAt: "2026-03-12T10:00:00.000Z" });
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const preview = await previewBatch(s.db, s.orgId, incidentId);
  assert.equal(preview.totals.count, 0);
  assert.equal(preview.notIncluded.needs_manual_handling, 1);
});
