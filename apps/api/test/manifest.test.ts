// What a person approves, and what the worker is then allowed to send.
//
// An approval covers one exact, unchangeable list (the manifest). These
// tests check that the list cannot be edited, that anything it rests on
// changing withdraws the approval, that the worker refuses a payment its
// approval no longer covers, and that money is not sent twice for the same
// purchase across incidents.

import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueue } from "../src/platform/jobs/queue.ts";
import { createBatch, decideBatch, previewBatch, reviseBatch, startBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { currentManifest, hashManifest, listManifests, manifestCsv } from "../src/modules/execution/manifests.ts";
import { answerConfirm, confirmQuestion, createConfirmLink } from "../src/modules/incidents/confirm.ts";
import { addRuleVersion, decideCandidates, reconcilePayment } from "../src/modules/incidents/service.ts";
import { scenario, type Scenario } from "./scenario.ts";

const scope = { type: "product", skus: ["CM-412"], batchCodes: ["LOT-24B"] } as const;

async function submitAndApprove(s: Scenario, batchId: string) {
  await submitBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  return decideBatch(s.deps, { orgId: s.orgId, batchId, userId: s.approver, role: "finance_approver", decision: "approve" });
}

const batchRow = async (s: Scenario, batchId: string) =>
  (await s.db.query<{ status: string; manifest_version: number; approved_manifest_id: string | null }>(
    "select status, manifest_version, approved_manifest_id from batches where id = $1", [batchId],
  ))[0]!;

const candidates = (s: Scenario, incidentId: string) =>
  s.db.query<{ id: string; status: string; payment_identity: string; eligibility: string; decision: string; payment_transaction_id: string | null }>(
    "select id, status, payment_identity, eligibility, decision, payment_transaction_id from candidates where incident_id = $1 and status <> 'cleared' order by created_at, id",
    [incidentId],
  );

test("the manifest lists exactly what the worker will send, explains each payment, and cannot be edited", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sell({ batchCode: null, shippedAt: null }); // nothing recorded: held, not paid
  await s.sell({ batchCode: "LOT-23A" }); // another batch: not affected
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);

  const { id: batchId, manifest } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" });
  const stored = (await currentManifest(s.db, s.orgId, batchId))!;
  const [op] = await s.operations(batchId);
  assert.equal(stored.version, 1);
  assert.equal(stored.content_hash, manifest.contentHash);
  // The hash covers the content as stored, with customer fields sealed; reading opens them.
  const [raw] = await s.db.query<{ content: Parameters<typeof hashManifest>[0] }>("select content from approval_manifests where id = $1", [stored.id]);
  assert.equal(hashManifest(raw!.content), stored.content_hash, "the hash is of the stored content");
  assert.match(String(raw!.content.items[0]!.customerEmail), /^pii1:/, "the stored list holds no readable customer email");

  const { items, notIncluded, rule, environment } = stored.content;
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.deepEqual(
    [item.operationId, item.requestId, item.kind, item.captureId, item.currency, item.amountMinor, item.amount],
    [op!.id, op!.idempotency_key, "refund", a.captureId, "USD", 5900, "59.00"],
  );
  assert.deepEqual([item.paymentIdentity, item.eligibility, item.confirmedBy], ["verified", "proven", null]);
  assert.equal(item.orderNumber, a.orderNumber);
  assert.deepEqual([item.captureGrossMinor, item.captureRefundedBeforeMinor], [5900, 0]);
  assert.ok(item.evidence.some((e) => e.source === "fulfilment_line" && e.kind === "fact" && e.dimension === "eligibility"));
  assert.ok(item.evidence.some((e) => e.source === "order_payment_link" && e.dimension === "payment"));
  assert.match(item.reason, /full refund/);
  assert.deepEqual(notIncluded.map((h) => [h.why, h.eligibility]), [["waiting_for_confirmation", "unknown"]], "the held customer is listed with the reason");
  assert.deepEqual(rule.scope, scope, "the rules are part of what was approved");
  assert.equal(environment, "simulator", "the list says where the money would move");
  assert.match(manifestCsv(stored.content, stored.content_hash), new RegExp(`${a.captureId},,USD,59.00`));

  // The refund-intent ledger: every planned payment explains itself.
  const [ledger] = await s.db.query<Record<string, unknown>>(
    `select incident_id, order_id, order_line_id, rule_version_id, manifest_id, manifest_version, reason, capture_gross_minor, capture_refunded_before_minor
       from payment_operations where id = $1`, [op!.id],
  );
  assert.equal(ledger!.incident_id, incidentId);
  assert.equal(ledger!.manifest_id, stored.id);
  assert.equal(ledger!.manifest_version, 1);
  assert.ok(ledger!.order_line_id && ledger!.rule_version_id && ledger!.reason);

  // The database itself refuses any change to a manifest.
  await assert.rejects(s.db.query("update approval_manifests set content = '{}'::jsonb where id = $1", [stored.id]), /cannot be changed/);
  await assert.rejects(s.db.query("update approval_manifests set content_hash = 'x' where id = $1", [stored.id]), /cannot be changed/);
  await assert.rejects(s.db.query("delete from approval_manifests where id = $1", [stored.id]), /never deleted/);
});

test("a newly matched customer withdraws the approval; an approval of the old list does not count for the new one", async () => {
  const s = await scenario();
  await s.db.query(`update organisations set settings = '{"approval": {"approvalsRequired": 2}}'::jsonb where id = $1`, [s.orgId]);
  const [owner] = await s.db.query<{ id: string }>("insert into users (email, email_normalized, name, password_hash) values ('o@k.test', 'o@k.test', 'Owner', 'x') returning id");
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" });
  assert.equal((await submitAndApprove(s, batchId)).status, "pending_approval", "two approvals are needed");
  const second = await decideBatch(s.deps, { orgId: s.orgId, batchId, userId: owner!.id, role: "owner", decision: "approve" });
  assert.deepEqual([second.status, second.approvals, second.manifestVersion], ["approved", 2, 1]);

  // Another affected order is imported and the match is run again.
  const b = await s.sell();
  await s.sync();
  const rerun = await s.match(incidentId);
  assert.deepEqual(rerun.invalidatedBatches, [batchId]);
  assert.deepEqual(await batchRow(s, batchId), { status: "draft", manifest_version: 1, approved_manifest_id: null });
  const [old] = await listManifests(s.db, s.orgId, batchId);
  assert.equal(old!.status, "invalidated");
  assert.ok(old!.invalidated_reason!.some((d) => d.kind === "customer_added"));
  await assert.rejects(startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /cannot go from "draft" to "executing"/);
  await assert.rejects(submitBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /no payment list in force/);
  assert.equal(s.paypal.refunds.size, 0);

  // A new version of the list is built and reviewed afresh.
  const revised = await reviseBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  assert.equal(revised.manifest.version, 2);
  assert.equal(revised.preview.totals.count, 2);
  const v2 = (await currentManifest(s.db, s.orgId, batchId))!;
  assert.equal(v2.content.previous!.version, 1);
  assert.ok(v2.content.previous!.invalidatedBecause.length > 0, "the new list records why the old one was withdrawn");
  const first = await submitAndApprove(s, batchId);
  assert.deepEqual([first.status, first.approvals, first.manifestVersion], ["pending_approval", 1, 2], "the owner's approval of version 1 does not count");
  const done = await decideBatch(s.deps, { orgId: s.orgId, batchId, userId: owner!.id, role: "owner", decision: "approve" });
  assert.equal(done.status, "approved");

  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  await s.settle();
  assert.deepEqual((await s.operations(batchId)).map((o) => o.state), ["succeeded", "succeeded"]);
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900);
  assert.equal(s.paypal.captures.get(b.captureId!)!.refundedMinor, 5900);
  assert.deepEqual((await listManifests(s.db, s.orgId, batchId)).map((m) => [m.version, m.status]), [[2, "current"], [1, "invalidated"]]);
});

test("changing the rules withdraws the approval, and the new list carries the new amounts", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" });
  await submitAndApprove(s, batchId);

  await addRuleVersion(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, scope, compensation: { type: "percent", percentBps: 5000 } } as never);
  assert.equal((await batchRow(s, batchId)).status, "draft");
  const [old] = await listManifests(s.db, s.orgId, batchId);
  assert.ok(old!.invalidated_reason!.some((d) => d.kind === "rule_changed"));
  await assert.rejects(reviseBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /Run the match again/);

  await s.match(incidentId);
  const revised = await reviseBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  assert.equal(revised.preview.items[0]!.amountMinor, 2950);
  assert.equal((await submitAndApprove(s, batchId)).status, "approved");
  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  await s.settle();
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 2950, "half, as the rules now say");
});

test("a change to a payment's refundable balance withdraws the approval before the batch starts", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId, false);

  // Someone refunds 10.00 in the PayPal dashboard, and the next sync of PayPal's records shows it.
  await s.paypal.refundCapture(a.captureId!, { requestId: "from-the-dashboard", amount: { currency_code: "USD", value: "10.00" } });
  await s.sync();
  await assert.rejects(startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /has changed since its payment list was built/);
  assert.equal((await batchRow(s, batchId)).status, "draft");
  const [old] = await listManifests(s.db, s.orgId, batchId);
  assert.ok(old!.invalidated_reason!.some((d) => d.kind === "balance_changed"));
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 1000, "nothing was sent on the stale approval");

  await s.match(incidentId);
  const revised = await reviseBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  assert.equal(revised.preview.items[0]!.amountMinor, 4900, "the new list pays only what is left on the payment");
  await submitAndApprove(s, batchId);
  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  await s.settle();
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900, "the payment is refunded in full, and no more");
});

test("after a batch has started, the worker withholds a payment its approval no longer covers", async () => {
  const s = await scenario();
  const a = await s.sell();
  const b = await s.sell();
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId);
  // Before the worker reaches B, PayPal's records show a refund on B's payment that was not there at approval.
  await s.db.query("update payment_transactions set refunded_minor = 1000 where transaction_id = $1", [b.captureId]);
  await s.settle();

  const ops = await s.operations(batchId);
  const forA = ops.find((o) => o.capture_id === a.captureId)!;
  const forB = ops.find((o) => o.capture_id === b.captureId)!;
  assert.equal(forA.state, "succeeded");
  assert.deepEqual([forB.state, forB.failure_code, forB.attempts], ["cancelled", "APPROVAL_NO_LONGER_COVERS", 0]);
  assert.equal(s.paypal.refundCallsFor(b.captureId!), 0, "PayPal was never asked");
  assert.equal((await s.batchStatus(batchId)).status, "completed_with_failures", "the withheld payment is not hidden");
  const [withheld] = await s.db.query<{ data: { detail: string } }>(
    "select data from audit_events where action = 'operation.cancelled' and entity_id = $1", [forB.id],
  );
  assert.match(withheld!.data.detail, /refundable balance/);
});

test("only operations on the approved list are released, whatever else is in the batch", async () => {
  const s = await scenario();
  const a = await s.sell();
  const held = await s.sell({ batchCode: null, shippedAt: null });
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId, false);
  const [listed] = await s.db.query<{ calculation_id: string; paypal_connection_id: string }>(
    "select calculation_id, paypal_connection_id from payment_operations where batch_id = $1", [batchId],
  );
  const other = (await candidates(s, incidentId)).find((c) => c.status === "proposed")!;
  const [calc] = await s.db.query<{ id: string }>("select id from compensation_calculations where candidate_id = $1 and is_current", [other.id]);

  // A payment row slipped into the batch after approval.
  const [rogue] = await s.db.query<{ id: string }>(
    `insert into payment_operations (org_id, batch_id, candidate_id, calculation_id, kind, paypal_connection_id, capture_id, currency, amount_minor, state, idempotency_key)
     values ($1, $2, $3, $4, 'refund', $5, $6, 'USD', 5900, 'planned', 'rogue-key') returning id`,
    [s.orgId, batchId, other.id, calc?.id ?? listed!.calculation_id, listed!.paypal_connection_id, held.captureId],
  );
  await assert.rejects(startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator }), /no longer match what was approved/);

  // Even if it is forced into the queue, the worker checks the approved list and will not send it.
  await s.db.query("delete from payment_operations where id = $1", [rogue!.id]);
  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  const [forced] = await s.db.query<{ id: string }>(
    `insert into payment_operations (org_id, batch_id, candidate_id, calculation_id, kind, paypal_connection_id, capture_id, currency, amount_minor, state, idempotency_key)
     values ($1, $2, $3, $4, 'refund', $5, $6, 'USD', 5900, 'queued', 'forced-key') returning id`,
    [s.orgId, batchId, other.id, calc?.id ?? listed!.calculation_id, listed!.paypal_connection_id, held.captureId],
  );
  await enqueue(s.db, { type: "operation.execute", orgId: s.orgId, payload: { operationId: forced!.id } }, s.clock.now());
  await s.settle();
  const ops = await s.operations(batchId);
  assert.equal(ops.find((o) => o.capture_id === a.captureId)!.state, "succeeded");
  assert.deepEqual(
    [ops.find((o) => o.id === forced!.id)!.state, ops.find((o) => o.id === forced!.id)!.failure_code],
    ["cancelled", "APPROVAL_NO_LONGER_COVERS"],
  );
  assert.equal(s.paypal.refundCallsFor(held.captureId!), 0);
});

test("a refund PayPal refuses stays failed: it is never turned into a payout", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const incidentId = await s.incident({ compensation: { type: "full_refund", allowPayout: true } });
  await s.match(incidentId);
  const { batchId } = await s.approvedBatch(incidentId, false);
  await s.paypal.refundCapture(a.captureId!, { requestId: "from-the-dashboard" }); // refunded elsewhere; our records do not know yet
  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  await s.settle();

  const [op] = await s.operations(batchId);
  assert.deepEqual([op!.state, op!.kind, op!.failure_code], ["failed_final", "refund", "CAPTURE_FULLY_REFUNDED"]);
  assert.equal(s.paypal.payouts.size, 0, "no payout was sent in its place");
  const [payouts] = await s.db.query<{ n: number }>("select count(*)::int as n from payment_operations where kind = 'payout'");
  assert.equal(payouts!.n, 0);
  assert.equal((await previewBatch(s.db, s.orgId, incidentId, { kind: "payout" })).totals.count, 0, "and none is offered without a new decision");
  assert.equal((await s.batchStatus(batchId)).status, "completed_with_failures");
});

test("the same purchase is not paid under two incidents unless a person reviews it", async () => {
  const s = await scenario();
  const a = await s.sell();
  await s.sync();
  const half = { type: "percent", percentBps: 5000 };
  const first = await s.incident({ compensation: half });
  await s.match(first);
  const planned = await createBatch(s.deps, { orgId: s.orgId, incidentId: first, userId: s.operator, name: "First" });

  // A second incident covers the same order while the first batch is still waiting.
  const second = await s.incident({ compensation: half });
  await s.match(second);
  assert.equal((await previewBatch(s.db, s.orgId, second)).notIncluded.payment_in_another_batch, 1);

  await submitAndApprove(s, planned.id);
  await startBatch(s.deps, { orgId: s.orgId, batchId: planned.id, userId: s.operator, spacingMs: 0 });
  await s.settle();
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 2950);

  await s.match(second);
  const blocked = await previewBatch(s.db, s.orgId, second);
  assert.equal(blocked.totals.count, 0);
  assert.equal(blocked.notIncluded.paid_under_another_incident, 1);
  await assert.rejects(createBatch(s.deps, { orgId: s.orgId, incidentId: second, userId: s.operator, name: "Second" }), /No confirmed customer/);

  // A named person looks at the earlier payment and decides this is a separate harm.
  const [candidate] = await candidates(s, second);
  const decided = await decideCandidates(s.deps, {
    orgId: s.orgId, incidentId: second, userId: s.operator, candidateIds: [candidate!.id], decision: "confirm",
    basis: "cross_incident_reviewed", note: "late delivery credit was separate from the recall",
  });
  assert.equal(decided.changed, 1);
  const { batchId } = await s.approvedBatch(second);
  await s.settle();
  assert.deepEqual((await s.operations(batchId)).map((o) => o.state), ["succeeded"]);
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 5900, "two halves: never more than was paid");
  assert.equal(s.paypal.refunds.size, 2);
});

test("two affected lines paid by one PayPal payment are refunded one batch at a time", async () => {
  const s = await scenario();
  const a = await s.sell({
    quantity: 2,
    extra: {
      total: "118.00",
      lines: [
        { externalId: "l1", sku: "CM-412", title: "Mug set CM-412", quantity: 1, unitPrice: "59.00" },
        { externalId: "l2", sku: "CM-412", title: "Mug set CM-412 (gift)", quantity: 1, unitPrice: "59.00" },
      ],
      fulfilments: [{
        externalId: "f1", shippedAt: "2026-09-10T10:00:00.000Z",
        lines: [{ lineExternalId: "l1", quantity: 1, batchCode: "LOT-24B" }, { lineExternalId: "l2", quantity: 1, batchCode: "LOT-24B" }],
      }],
    } as never,
  });
  await s.sync();
  const incidentId = await s.incident();
  assert.equal((await s.match(incidentId)).autoConfirmed, 2);
  const preview = await previewBatch(s.db, s.orgId, incidentId);
  assert.equal(preview.totals.count, 1);
  assert.equal(preview.notIncluded.second_refund_on_same_payment, 1);

  const one = await s.approvedBatch(incidentId);
  await s.settle();
  await s.match(incidentId);
  const two = await s.approvedBatch(incidentId);
  await s.settle();
  assert.deepEqual([...(await s.operations(one.batchId)), ...(await s.operations(two.batchId))].map((o) => [o.state, o.amount_minor]), [["succeeded", 5900], ["succeeded", 5900]]);
  assert.equal(s.paypal.captures.get(a.captureId!)!.refundedMinor, 11800);
  assert.equal(s.paypal.refunds.size, 2);
});

test("confirming a record cannot settle which payment paid for it; reconciling the payment does", async () => {
  const s = await scenario();
  // The store did not record PayPal's payment ID, and two PayPal payments carry the order number.
  const a = await s.sell({ extra: { paymentReference: null } as never });
  const twin = s.paypal.addCapture({
    amountMinor: 5900, currency: "USD", createdAt: new Date("2026-09-08T10:03:00.000Z"), payerEmail: a.email, payerId: "SIMPAYERTWIN",
    invoiceId: a.orderNumber, items: [{ code: "CM-412", name: "Mug set", quantity: 1, unitMinor: 5900 }],
  });
  await s.sync();
  const incidentId = await s.incident();
  const result = await s.match(incidentId);
  assert.equal(result.autoConfirmed, 0);
  assert.equal(result.byDecision.reconcile_payment, 1);
  const [candidate] = await candidates(s, incidentId);
  assert.deepEqual([candidate!.payment_identity, candidate!.eligibility, candidate!.status], ["ambiguous", "proven", "proposed"]);

  const refusal = await decideCandidates(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, candidateIds: [candidate!.id], decision: "confirm" });
  assert.equal(refusal.changed, 0);
  assert.match(refusal.refused[0]!.why, /Reconcile the payment first/);
  assert.equal((await previewBatch(s.db, s.orgId, incidentId)).totals.count, 0);

  // Even a record forced to "confirmed" is not paid while its payment is not settled.
  await s.db.query("update candidates set status = 'confirmed' where id = $1", [candidate!.id]);
  assert.equal((await previewBatch(s.db, s.orgId, incidentId)).notIncluded.payment_not_reconciled, 1);
  await s.db.query("update candidates set status = 'proposed' where id = $1", [candidate!.id]);

  const [real] = await s.db.query<{ id: string }>("select id from payment_transactions where transaction_id = $1", [a.captureId]);
  await reconcilePayment(s.deps, { orgId: s.orgId, candidateId: candidate!.id, paymentTransactionId: real!.id, userId: s.operator, note: "matched the PayPal receipt the customer sent" });
  const after = await s.match(incidentId);
  assert.equal(after.autoConfirmed, 1);
  const [settled] = await candidates(s, incidentId);
  assert.deepEqual([settled!.payment_identity, settled!.decision, settled!.payment_transaction_id], ["verified", "ready_for_approval", real!.id]);

  const { batchId } = await s.approvedBatch(incidentId);
  await s.settle();
  assert.deepEqual((await s.operations(batchId)).map((o) => [o.state, o.capture_id]), [["succeeded", a.captureId]]);
  assert.equal(s.paypal.captures.get(twin.id)!.refundedMinor, 0, "the other payment was not touched");
});

test("a person's confirmation is stored in their name, survives a new match and is shown on the list", async () => {
  const s = await scenario();
  await s.sell({ batchCode: null, shippedAt: null });
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const [candidate] = await candidates(s, incidentId);
  assert.deepEqual([candidate!.eligibility, candidate!.decision, candidate!.status], ["unknown", "needs_eligibility_evidence", "proposed"]);

  // A status on a record is never enough on its own: without a named person, an unproven record is not paid.
  await s.db.query("update candidates set status = 'confirmed' where id = $1", [candidate!.id]);
  assert.equal((await previewBatch(s.db, s.orgId, incidentId)).notIncluded.eligibility_not_confirmed, 1);
  await s.db.query("update candidates set status = 'proposed' where id = $1", [candidate!.id]);

  await decideCandidates(s.deps, {
    orgId: s.orgId, incidentId, userId: s.operator, candidateIds: [candidate!.id], decision: "confirm",
    basis: "customer_confirmed_unit", note: "customer sent a photo of the mug's base: LOT-24B",
  });
  await s.match(incidentId);
  const evidence = await s.db.query<{ source: string; kind: string; fact: string }>(
    "select source, kind, fact from match_evidence where candidate_id = $1 and source = 'customer_statement'", [candidate!.id],
  );
  assert.equal(evidence.length, 1, "kept across the new match, and not duplicated");
  assert.match(evidence[0]!.fact, /olive confirmed this record .* photo of the mug's base/);

  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" });
  const item = (await currentManifest(s.db, s.orgId, batchId))!.content.items[0]!;
  assert.deepEqual([item.eligibility, item.confirmedBy, item.confirmationBasis], ["unknown", "olive", "customer_confirmed_unit"]);
  assert.ok(item.evidence.some((e) => e.source === "customer_statement"));
});

test("a customer's answer through a link is evidence for staff, and pays nobody by itself", async () => {
  const s = await scenario();
  const a = await s.sell({ batchCode: null, shippedAt: null });
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const [candidate] = await candidates(s, incidentId);
  const { token } = await createConfirmLink(s.deps, { orgId: s.orgId, candidateId: candidate!.id, userId: s.operator });
  const asked = await confirmQuestion(s.deps, token);
  assert.deepEqual([asked.orderNumber, asked.product], [a.orderNumber, "Mug set CM-412"]);
  assert.equal(JSON.stringify(asked).includes(a.email), false, "the page shows no email address");

  await answerConfirm(s.deps, { token, batchCode: " lot 24b " });
  await assert.rejects(answerConfirm(s.deps, { token, batchCode: "LOT-24B" }), /not found/, "the link works once");
  await s.match(incidentId);
  const [after] = await candidates(s, incidentId);
  assert.equal(after!.status, "proposed", "the record is still waiting for a member of staff");
  assert.equal((await previewBatch(s.db, s.orgId, incidentId)).totals.count, 0);
  const [evidence] = await s.db.query<{ fact: string; strength: string }>(
    "select fact, strength from match_evidence where candidate_id = $1 and source = 'customer_statement'", [candidate!.id],
  );
  assert.equal(evidence!.strength, "supports");
  assert.match(evidence!.fact, /entered the batch code "lot 24b".*It is an affected batch/);

  await decideCandidates(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, candidateIds: [candidate!.id], decision: "confirm", basis: "customer_confirmed_unit" });
  assert.equal((await previewBatch(s.db, s.orgId, incidentId)).totals.count, 1);
});
