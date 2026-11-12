// The flagship case, end to end, through the HTTP API on the simulator:
//
//   supplier notice ─▶ fields read from it ─▶ a person saves the rules ─▶
//   match (two answers per record) ─▶ Recovery Map ─▶ policies priced ─▶
//   people settle what the records cannot ─▶ payment list ─▶ approval ─▶
//   refunds, with one lost reply and one refusal ─▶ accuracy against the
//   known answers ─▶ ledger and audit trail.
//
// The merchant records are synthetic and deliberately untidy. The right
// answer for each is stored where the matching engine cannot read it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/api/routes.ts";
import { createContainer, type Container } from "../src/container.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { loadConfig } from "../src/platform/config.ts";
import { verifyAuditChain } from "../src/platform/audit.ts";
import type { EvidenceAi } from "../src/modules/evidence/ai.ts";
import { checkExtraction, readWithPatternRules } from "../src/modules/evidence/extract.ts";
import { recallNotice } from "../src/modules/demo/recall-scenario.ts";
import { testDb } from "./helpers.ts";

type Reply = { status: number; body: any; text: string; headers: Record<string, unknown> };

async function harness(ai: EvidenceAi | null = null) {
  const db = await testDb();
  const clock = new FakeClock("2026-11-11T09:00:00.000Z");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000" }, { readEnvFiles: false });
  const container: Container = await createContainer(config, { db, clock, passwordCost: { N: 1024, r: 8, p: 1 }, ai });
  const { app } = buildApp(container);
  await app.ready();
  let cookie = "";
  const call = async (method: string, url: string, body?: unknown): Promise<Reply> => {
    const res = await app.inject({
      method: method as "GET", url, payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-make-good": "1" }), ...(cookie ? { cookie } : {}) },
    });
    const set = res.headers["set-cookie"];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    let parsed: unknown = null;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed, text: res.body, headers: res.headers };
  };
  const get = (url: string) => call("GET", url);
  const post = (url: string, body: unknown = {}) => call("POST", url, body);
  const ok = async (reply: Promise<Reply>): Promise<any> => {
    const r = await reply;
    assert.equal(r.status, 200, r.text);
    return r.body;
  };

  await ok(post("/api/auth/register", { email: "ada@example.com", password: "correct horse battery", name: "Ada" }));
  const org: string = (await ok(post("/api/orgs", { name: "Emberline Ceramics" }))).id;
  await ok(post(`/api/orgs/${org}/paypal/simulator`));
  const seeded = await ok(post(`/api/orgs/${org}/demo/recall-scenario`));
  const sim = await container.connections.simulatorFor(org);

  /** Runs the worker until nothing is due, moving the clock forward as the queue asks. */
  async function settle(horizonMs = 2 * 60 * 60_000) {
    let waited = 0;
    for (;;) {
      await container.runner.drain();
      const [next] = await db.query<{ run_at: Date }>("select run_at from jobs where status = 'queued' order by run_at limit 1");
      if (!next) return;
      const gap = Math.max(0, new Date(next.run_at).getTime() - clock.now().getTime());
      if (waited + gap > horizonMs) return;
      clock.advance(gap + 1);
      waited += gap + 1;
    }
  }
  const api = `/api/orgs/${org}`;
  const inc = `${api}/incidents/${seeded.incidentId}`;
  const rows = async (query = "") => (await ok(get(`${inc}/candidates?size=200${query}`))).rows as any[];
  return { db, clock, container, sim, org, api, inc, seeded, get, post, ok, settle, rows };
}

const SCOPE = { type: "product", skus: ["CM-412", "CM-412-GB"], batchCodes: ["K-0719"] };

test("the recall case, from the supplier's notice to PayPal's confirmation", async () => {
  const h = await harness();
  assert.deepEqual([h.seeded.orders, h.seeded.labels], [32, 29]);

  // ---- 1. What went wrong: the notice is read, and a person saves the rules ----
  const evidence = await h.ok(h.get(`${h.inc}/evidence`));
  assert.equal(evidence.documents.length, 1);
  assert.equal(evidence.documents[0].data_label, "synthetic", "the notice is marked as invented");
  assert.equal(evidence.ai.configured, false);
  assert.equal((await h.post(`${h.inc}/documents/${h.seeded.documentId}/extract`, { method: "ai" })).status, 503, "no key, so no AI, and it says so");

  const read = await h.ok(h.post(`${h.inc}/documents/${h.seeded.documentId}/extract`, { method: "auto" }));
  assert.equal(read.method, "pattern_rules", "with no key, the stored reading says pattern rules did it");
  assert.deepEqual(read.output.proposedScope, SCOPE);
  assert.deepEqual(read.output.proposedCompensation, { type: "full_refund" });
  const product = (code: string) => read.output.products.find((p: any) => p.code === code);
  assert.equal(product("CM-4120").included, false, "the dinner set is named as not affected");
  assert.deepEqual(read.output.batchCodes.map((b: any) => [b.code, b.affected]), [["K-0719", true], ["K-0711", false], ["K-0726", false]]);
  assert.ok(evidence.documents[0].body.includes(product("CM-412-GB").quote), "each field quotes the notice word for word");
  assert.equal((await h.get(`${h.inc}/recovery-map`)).body.rule, null, "reading a notice applies nothing");

  const tooWide = await h.post(`${h.inc}/extractions/${read.id}/accept`, { scope: { ...SCOPE, batchCodes: ["K-0719", "K-0720"] }, compensation: { type: "full_refund" } });
  assert.equal(tooWide.status, 422, "a batch the notice never mentions cannot be saved as coming from it");
  assert.equal((await h.ok(h.post(`${h.inc}/extractions/${read.id}/accept`, { scope: SCOPE, compensation: { type: "full_refund" } }))).version, 1);

  // ---- 2. Who might be affected: two answers per record ----
  const match = await h.ok(h.post(`${h.inc}/match`));
  assert.deepEqual(match.disputes, { checked: match.disputes.checked, open: 1, changed: 1, failed: null }, "PayPal was asked about disputes before anyone was called payable");
  assert.deepEqual(match.byDecision, {
    ready_for_approval: 10, needs_eligibility_evidence: 5, reconcile_payment: 4, pay_outside_paypal: 1,
    on_hold: 1, excluded: 2, investigate: 1, not_affected: 4,
  });
  assert.equal(match.cleared, 4);

  const map = await h.ok(h.get(`${h.inc}/recovery-map`));
  assert.deepEqual(map.dataLabels, {
    paypal: "simulator", paypalMeaning: map.dataLabels.paypalMeaning, merchantRecords: "synthetic", knownAnswersAvailable: true,
  });
  assert.match(map.dataLabels.paypalMeaning, /No request leaves this machine/);
  const group = (m: any, d: string) => m.groups.find((g: any) => g.disposition === d) ?? { count: 0, amount: {} };
  assert.equal(group(map, "ready").count, 10);
  assert.equal(group(map, "ready").amount.USD, 5900 * 6 + 11800 + 5310 + 3900 + 5900, "full, partial and reduced refunds add up exactly");
  assert.equal(group(map, "not_affected").count, 4);
  assert.equal(group(map, "on_hold").count, 1);
  assert.deepEqual(map.restricted, { returned: 1, already_refunded: 1, dispute_open: 1 });
  const cell = (identity: string, eligibility: string) => map.matrix.find((m: any) => m.paymentIdentity === identity && m.eligibility === eligibility)?.count ?? 0;
  assert.deepEqual(
    [cell("verified", "proven"), cell("verified", "supported"), cell("verified", "uncertain"), cell("ambiguous", "proven"), cell("missing", "proven"), cell("missing", "unknown")],
    [10, 2, 2, 3, 1, 1],
  );

  // ---- 3. What the evidence says: one held record, in full ----
  const mixed = (await h.rows("&eligibility=uncertain"))[0];
  assert.deepEqual([mixed.disposition, mixed.payment_identity, mixed.decision], ["needs_eligibility_evidence", "verified", "needs_eligibility_evidence"]);
  const detail = await h.ok(h.get(`${h.api}/candidates/${mixed.id}`));
  assert.ok(detail.evidence.some((e: any) => e.dimension === "payment" && e.kind === "fact" && e.strength === "proves"));
  assert.ok(detail.evidence.some((e: any) => e.dimension === "eligibility" && e.kind === "inference" && e.strength === "contradicts"), "the other batch is recorded as contrary evidence");
  assert.match(detail.candidate.missing.join(" "), /Mixed stock/);
  assert.equal((await h.post(`${h.api}/candidates/${mixed.id}/explain`)).status, 503, "the AI explanation needs a key; the evidence list does not");

  // ---- 4. Product codes written differently: found by rule, decided by a person ----
  const before = await h.ok(h.get(`${h.inc}/evaluation`));
  assert.deepEqual(
    [before.eligibility.truthAffectedUnits, before.eligibility.correct, before.eligibility.wrongInclusions, before.eligibility.missed],
    [23, 18, 0, 2],
    "two affected units are missed at first: their order lines spell the product differently",
  );
  const suggested = await h.ok(h.post(`${h.inc}/aliases/suggest`, { withAi: false }));
  const alias = (text: string) => suggested.aliases.find((a: any) => a.alias === text);
  assert.deepEqual(suggested.aliases.map((a: any) => [a.alias, a.status]).sort(), [
    ["CM-4120", "suggested"], ["CM412", "suggested"], ["Wrenfield mug set CM-412 white", "suggested"],
  ]);
  assert.match(alias("CM-4120").reason, /extra characters/);
  assert.deepEqual(alias("CM-4120").batchCodes, ["K-0719", "S-0412"], "the look-alike even carries the recalled batch number: a trap");
  assert.equal((await h.ok(h.post(`${h.inc}/match`))).byDecision.ready_for_approval, 10, "a suggestion changes nothing");
  await h.ok(h.post(`${h.api}/aliases/${alias("CM412").id}/decision`, { decision: "confirm" }));
  await h.ok(h.post(`${h.api}/aliases/${alias("Wrenfield mug set CM-412 white").id}/decision`, { decision: "confirm" }));
  await h.ok(h.post(`${h.api}/aliases/${alias("CM-4120").id}/decision`, { decision: "reject" }));
  assert.equal((await h.ok(h.post(`${h.inc}/match`))).byDecision.ready_for_approval, 12);
  const after = await h.ok(h.get(`${h.inc}/evaluation`));
  assert.deepEqual(
    [after.eligibility.correct, after.eligibility.wrongInclusions, after.eligibility.missed, after.eligibility.heldAffected, after.eligibility.heldNotAffected],
    [20, 0, 0, 3, 2],
  );
  assert.deepEqual([after.eligibility.precision, after.eligibility.recall, after.eligibility.foundOrHeld], [1, 0.87, 1]);
  assert.deepEqual(
    [after.payment.verifiedAndRight, after.payment.falseMatches, after.payment.held, after.payment.noPayPalPayment],
    [20, 0, 3, 2],
    "no payment was tied to the wrong order; three are held",
  );
  assert.deepEqual([after.amounts.compared, after.amounts.exact, after.amounts.mismatches], [12, 12, []]);

  // ---- 5. Options and what each costs ----
  const priced = await h.ok(h.post(`${h.inc}/policies/compare`));
  const policy = (key: string) => priced.policies.find((p: any) => p.key === key);
  const provenTotal = 5900 * 8 + 11800 + 5310 + 3900 + 5900;
  assert.deepEqual([policy("proven_only").payNow.customers, policy("proven_only").payNow.amount.USD], [12, provenTotal]);
  assert.deepEqual(policy("proven_only").againstKnownAnswers, { unitsPaidThatWereNotAffected: 0, affectedUnitsNotPaidNow: 8 });
  assert.deepEqual([policy("include_likely").payNow.customers, policy("include_likely").payNow.amount.USD], [16, provenTotal + 4 * 5900]);
  assert.deepEqual([policy("include_likely").ofWhichUnproven.customers, policy("include_likely").ofWhichUnproven.amount.USD], [4, 4 * 5900]);
  assert.equal(policy("include_likely").againstKnownAnswers.unitsPaidThatWereNotAffected, 1, "paying on the ship date alone pays one customer who was not affected");
  assert.equal(policy("ask_the_rest").askedToConfirm, 6);
  assert.equal(policy("proven_only").blockedUntilPaymentReconciled.customers, 3);
  const cheaper = await h.ok(h.post(`${h.inc}/policies/compare`, { policies: [{ key: "half", label: "Half back", include: ["proven"], compensation: { type: "percent", percentBps: 5000 } }] }));
  assert.equal(cheaper.policies[0].payNow.customers, 12);
  // Half of each line. The order that already had 20.00 back still gets its full half (29.50): 20.00 + 29.50 is within the 59.00 paid.
  assert.equal(cheaper.policies[0].payNow.amount.USD, (5900 * 8 + 11800 + 5310 + 5900) / 2 + 2950, "a different rule is priced without being saved");
  assert.equal((await h.ok(h.get(`${h.inc}/recovery-map`))).rule.version, 1, "pricing a policy saves nothing");

  // ---- 6. People settle what the records cannot ----
  const supported = await h.rows("&eligibility=supported");
  const confirmed = await h.ok(h.post(`${h.inc}/candidates/decide`, {
    candidateIds: supported.map((r) => r.id), decision: "confirm", basis: "merchant_records_checked", note: "warehouse pick sheets for that week show K-0719 only",
  }));
  assert.equal(confirmed.changed, 2);

  const ambiguous = await h.rows("&paymentIdentity=ambiguous");
  assert.equal(ambiguous.length, 3);
  const refused = await h.ok(h.post(`${h.inc}/candidates/decide`, { candidateIds: ambiguous.map((r) => r.id), decision: "confirm", basis: "merchant_records_checked" }));
  assert.equal(refused.changed, 0, "a confirmation cannot settle which payment paid");
  const duplicates = ambiguous.filter((r) => r.order_number === "#4871");
  assert.equal(duplicates.length, 2);
  for (const d of duplicates) {
    const options = (await h.ok(h.get(`${h.api}/candidates/${d.id}`))).paymentOptions;
    assert.equal(options.length, 2, "both payments that carry the order number are offered");
    const [truth] = await h.db.query<{ id: string }>(
      `select p.id from evaluation_labels e join candidates c on c.org_id = e.org_id and c.order_line_id = e.order_line_id
         join payment_transactions p on p.org_id = e.org_id and p.transaction_id = e.true_capture_id where c.id = $1`, [d.id],
    );
    // In the test, the person picks the payment that is in truth the right one, as they would from a receipt.
    await h.ok(h.post(`${h.api}/candidates/${d.id}/reconcile-payment`, { paymentTransactionId: truth!.id, note: "matched the PayPal receipt the customer forwarded" }));
  }
  const settled = (await h.rows("")).filter((r) => r.order_number === "#4871");
  assert.deepEqual(settled.map((r) => [r.payment_identity, r.disposition]), [["verified", "ready"], ["verified", "ready"]]);

  // ---- 7. What is approved: one exact list ----
  const preview = await h.ok(h.get(`${h.inc}/preview`));
  assert.equal(preview.totals.count, 16);
  // Left out: two mixed-stock orders, one with no shipping record, one guessed payment, one payment PayPal does not know,
  // one payment with no order; the card payer; and the returned, already refunded and disputed orders.
  assert.deepEqual(preview.notIncluded, { waiting_for_confirmation: 6, needs_manual_handling: 1, excluded: 3 });
  const batch = await h.ok(h.post(`${h.inc}/batches`, { name: "CM-412 recall, first payment list" }));
  const manifest = await h.ok(h.get(`${h.api}/batches/${batch.id}/manifest`));
  assert.deepEqual([manifest.version, manifest.status, manifest.content.items.length, manifest.content.environment], [1, "current", 16, "simulator"]);
  assert.equal(manifest.content.items.reduce((a: number, i: any) => a + i.amountMinor, 0), provenTotal + 4 * 5900);
  assert.equal(manifest.content.notIncluded.length, 10, "the list also names everyone it leaves out, with the reason");
  const byPerson = manifest.content.items.filter((i: any) => i.confirmedBy === "Ada");
  assert.deepEqual(byPerson.map((i: any) => [i.eligibility, i.confirmationBasis]), [["supported", "merchant_records_checked"], ["supported", "merchant_records_checked"]]);
  const csv = await h.get(`${h.api}/batches/${batch.id}/manifest?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers["content-type"]), /text\/csv/);
  assert.equal(csv.text.trim().split("\r\n").length, 17, "a header and one row per payment");
  assert.ok(csv.text.includes(manifest.contentHash), "the export carries the hash of the list it came from");

  await h.ok(h.post(`${h.api}/batches/${batch.id}/submit`));
  assert.equal((await h.ok(h.post(`${h.api}/batches/${batch.id}/decision`, { decision: "approve", comment: "checked against the list" }))).status, "approved");

  // ---- 8. What actually happened ----
  // Two things go wrong on purpose. One reply from PayPal is lost after PayPal has acted. And one payment
  // was refunded in the PayPal dashboard after approval, which our records do not show yet.
  const items = manifest.content.items as any[];
  const refundedElsewhere = items.find((i) => i.amountMinor === 5310); // the multi-item order
  await h.sim.refundCapture(refundedElsewhere.captureId, { requestId: "from-the-dashboard" });
  h.sim.failNext({ on: "refund", when: "after", kind: "timeout" });
  assert.equal((await h.ok(h.post(`${h.api}/batches/${batch.id}/start`))).queued, 16);
  await h.settle();

  const done = await h.ok(h.get(`${h.api}/batches/${batch.id}?size=100`));
  assert.equal(done.batch.status, "completed_with_failures");
  const states = Object.fromEntries(done.states.map((s: any) => [s.state, s.n]));
  assert.deepEqual(states, { succeeded: 15, failed_final: 1 });
  const failed = done.operations.find((o: any) => o.state === "failed_final");
  assert.deepEqual([failed.capture_id, failed.failure_code, failed.kind], [refundedElsewhere.captureId, "CAPTURE_FULLY_REFUNDED", "refund"]);
  assert.equal(h.sim.payouts.size, 0, "the refused refund was not sent some other way");
  const lost = done.operations.find((o: any) => o.attempts > 1);
  assert.equal(lost.state, "succeeded", "the lost reply was resolved by asking PayPal again with the same request ID");
  // At least one retry. Under a loaded machine a lease can expire and the check run once more; what matters is the next line.
  assert.ok(h.sim.refundCallsFor(lost.capture_id) >= 2);
  assert.equal([...h.sim.refunds.values()].filter((r) => r.captureId === lost.capture_id).length, 1, "and PayPal made one refund, not two");
  assert.ok(done.operations.filter((o: any) => o.state === "succeeded").every((o: any) => o.provider_refund_id?.startsWith("SIMREF")));

  const finalMap = await h.ok(h.get(`${h.inc}/recovery-map`));
  assert.equal(group(finalMap, "paid").count, 15);
  assert.equal(group(finalMap, "payment_failed").count, 1);
  assert.equal(finalMap.liability.paid.USD, provenTotal + 4 * 5900 - 5310);

  const final = await h.ok(h.get(`${h.inc}/evaluation`));
  assert.deepEqual(
    [final.money.linesPaid, final.money.overpaidLines, final.money.underpaidLines, final.money.paidToUnaffected, final.money.linesRefundedMoreThanOnce],
    [15, 0, 0, 0, 0],
  );
  assert.equal(final.money.paidMinor, final.money.owedOnPaidLinesMinor, "every paid line received exactly what was owed");
  assert.deepEqual(final.duplicates, { paymentsRefundedTwiceInThisIncident: 0, paymentsRefundedBeyondTheirAmount: 0 });
  assert.deepEqual(final.people, { confirmed: 2, confirmedAndAffected: 2, confirmedButNotAffected: 0, declined: 0, declinedButAffected: 0 });
  assert.equal(final.workload.waitingForAPerson, 6);
  assert.ok(final.completion.reconciliation.some((r: any) => r.kind === "unknown_resolved_succeeded" && r.status === "resolved"));
  assert.match(final.basis, /not measurements of any merchant/);

  // ---- The ledger and the audit trail ----
  const ledger = await h.ok(h.get(`${h.api}/ledger?incidentId=${h.seeded.incidentId}&size=100`));
  assert.equal(ledger.total, 16);
  for (const row of ledger.rows) {
    assert.ok(row.request_id && row.capture_id && row.order_number && row.reason && row.rule_version === 1 && row.manifest_version === 1, "each row explains itself");
    assert.equal(row.state === "succeeded", Boolean(row.provider_refund_id));
  }
  const partial = items.find((i) => i.amountMinor === 3900);
  const balance = await h.ok(h.get(`${h.api}/ledger/captures/${partial.captureId}`));
  assert.deepEqual(
    [balance.payment.gross_minor, balance.refundedElsewhereMinor, balance.refundedByMakeGoodMinor, balance.availableMinor],
    [5900, 2000, 3900, 0],
    "20.00 went back before the incident, 39.00 now: the payment is used up, and no more",
  );
  const audit = await verifyAuditChain(h.db, h.org);
  assert.equal(audit.ok, true);
  const actions = new Set((await h.db.query<{ action: string }>("select distinct action from audit_events where org_id = $1", [h.org])).map((a) => a.action));
  for (const action of ["evidence.extracted", "evidence.extraction_accepted", "alias.confirm", "alias.reject", "candidates.confirm", "payment.reconciled", "batch.created", "batch.approve", "batch.started", "operation.succeeded", "operation.unknown", "operation.failed_final"]) {
    assert.ok(actions.has(action), `the audit trail records ${action}`);
  }

  // Customer data at rest: after the whole case, no customer email or name can be read anywhere in the database.
  const people = await h.db.query<{ customer_email: string | null; customer_name: string | null }>(
    "select customer_email, customer_name from orders where org_id = $1",
    [h.org],
  );
  const secrets = new Set(people.flatMap((p) => [p.customer_email, p.customer_name]).filter((v): v is string => Boolean(v && v.length > 3)));
  assert.ok(secrets.size > 20, "the database layer opens the data for the code that reads it");
  assert.ok([...secrets].some((v) => v.includes("@")));
  const tables = await h.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not in ('users', 'sessions', 'account_tokens')",
  );
  const leaks: string[] = [];
  for (const { table_name } of tables) {
    const dump = (await h.db.query<{ t: string }>(`select t::text as t from ${table_name} t`)).map((r) => r.t.toLowerCase()).join(" | ");
    for (const secret of secrets) if (dump.includes(secret.toLowerCase())) leaks.push(`${table_name}: ${secret}`);
  }
  assert.deepEqual(leaks, [], "customer names and emails are stored only encrypted");
  const [one] = await h.db.query<{ raw: string; idx: string }>("select customer_email::text as raw, customer_email_normalized as idx from orders where org_id = $1 and customer_email is not null limit 1", [h.org]);
  assert.match(one!.idx, /^h1:[0-9a-f]{64}$/);
});

// ---------- evidence reading: the checks every reader's output goes through ----------

test("a field survives only if it quotes the document and its value is inside the quote", () => {
  const notice = recallNotice(new Date("2026-11-11T09:00:00Z")).body;
  const catalogue = ["PL-80", " cm-412", "CM-412", "CM-412-GB", "CM-4120", "CM412", "TP-120"];
  const honest = checkExtraction(notice, readWithPatternRules(notice, catalogue), catalogue);
  assert.deepEqual(honest.dropped, []);
  assert.deepEqual(honest.proposedScope, SCOPE);
  assert.equal(honest.dates.length, 1, "the supplier's dispatch dates are reported with their sentence, and not used to narrow the match");

  // A reader that invents a batch, misquotes, or puts a code in a sentence that does not contain it.
  const invented = checkExtraction(notice, {
    products: [
      { code: "CM-412", name: "mug set", included: true, quote: "Product: CM-412 mug set (catalogue code CM-412)." },
      { code: "TP-120", name: "teapot", included: true, quote: "Product: CM-412 mug set (catalogue code CM-412)." },
    ],
    batchCodes: [
      { code: "K-0719", affected: true, quote: "Affected production batch: K-0719 only." },
      { code: "K-0720", affected: true, quote: "Batch K-0720 is also affected and must be recalled." },
    ],
    dates: [], remedy: [{ kind: "full_refund", quote: "Customers are entitled to a full refund and compensation." }], fault: [], notStated: [],
  }, catalogue);
  assert.deepEqual(invented.dropped.map((d) => [d.field, d.value]), [["product", "TP-120"], ["batch", "K-0720"], ["remedy", "full_refund"]]);
  assert.deepEqual(invented.proposedScope, { type: "product", skus: ["CM-412"], batchCodes: ["K-0719"] });
  assert.equal(invented.proposedCompensation, null, "an unquoted remedy proposes nothing");
});

test("the AI's output is checked like any other reader's, and it can decide nothing", async () => {
  const notice = recallNotice(new Date("2026-11-11T09:00:00Z")).body;
  const calls: string[] = [];
  // Stands in for the model. It answers the way a careless or manipulated model might.
  const model: EvidenceAi = {
    provider: "gemini",
    model: "stand-in-model",
    readNotice: async () => {
      calls.push("readNotice");
      return {
        products: [
          { code: "CM-412", name: "mug set", included: true, quote: "Product: CM-412 mug set (catalogue code CM-412)." },
          { code: "CM-412-GB", name: "", included: true, quote: "The gift-boxed version, sold as CM-412-GB, is the same set and is included in this recall." },
        ],
        batchCodes: [
          { code: "K-0719", affected: true, quote: "Affected production batch: K-0719 only." },
          { code: "K-0726", affected: true, quote: "Batch K-0726 should be treated as affected as a precaution." },
        ],
        dates: [], remedy: [], fault: [], notStated: ["How many units were in the batch."],
      };
    },
    judgeAliases: async ({ candidates }) => {
      calls.push("judgeAliases");
      return {
        opinions: candidates.map((c) => ({
          id: c.id,
          verdict: c.alias === "CM-4120" ? "different_product" as const : "same_product" as const,
          reason: "The title names the same model.",
          // For one of them the model "quotes" a title that is on no order line.
          quotedTitle: c.alias === "CM412" ? "Mug set CM-412 original" : c.sampleTitles[0]!,
        })),
      };
    },
    explainRecord: async (input) => {
      calls.push("explainRecord");
      return {
        summary: "The payment is verified, but no record says which batch was packed.",
        points: [
          { text: "The order was shipped while two batches were going out.", cites: [input.evidence[0]!.id] },
          { text: "The customer probably has an affected unit and should be refunded.", cites: ["E99"] },
          { text: "Pay this customer.", cites: [] },
        ],
        contradictions: [{ text: "Inventory shows another batch shipping the same day.", cites: [input.evidence[0]!.id, input.evidence[1]!.id] }],
        whatWouldSettleIt: "The batch code on the unit.",
      };
    },
  };
  const h = await harness(model);

  const read = await h.ok(h.post(`${h.inc}/documents/${h.seeded.documentId}/extract`, { method: "auto" }));
  assert.deepEqual([read.method, read.model], ["gemini", "stand-in-model"]);
  assert.deepEqual(read.output.dropped.map((d: any) => d.value), ["K-0726"], "the batch the model made a sentence up for is dropped");
  assert.deepEqual(read.output.proposedScope, SCOPE);
  assert.ok(notice.includes(read.output.batchCodes[0].quote));
  assert.equal((await h.ok(h.get(`${h.inc}/recovery-map`))).rule, null, "what the model read is a proposal: no rules exist until a person saves them");
  await h.ok(h.post(`${h.inc}/extractions/${read.id}/accept`, { scope: SCOPE, compensation: { type: "full_refund" } }));
  await h.ok(h.post(`${h.inc}/match`));

  const suggested = await h.ok(h.post(`${h.inc}/aliases/suggest`, { withAi: true }));
  assert.equal(suggested.aiUsed, true);
  const alias = (text: string) => suggested.aliases.find((a: any) => a.alias === text);
  assert.equal(alias("CM412").ai, null, "an opinion that quotes a title no order line has is thrown away");
  assert.deepEqual([alias("CM-4120").ai.verdict, alias("CM-4120").ai.model], ["different_product", "stand-in-model"]);
  assert.equal(alias("Wrenfield mug set CM-412 white").ai.verdict, "same_product");
  assert.ok(suggested.aliases.every((a: any) => a.status === "suggested"), "the model's opinion confirms nothing");
  assert.equal((await h.ok(h.post(`${h.inc}/match`))).byDecision.ready_for_approval, 10, "and matches nobody");

  const held = (await h.rows("&eligibility=uncertain"))[0];
  const explained = await h.ok(h.post(`${h.api}/candidates/${held.id}/explain`));
  assert.equal(explained.model, "stand-in-model");
  assert.equal(explained.explanation.points.length, 1, "points that cite nothing real are dropped");
  assert.equal(explained.dropped, 2);
  const still = (await h.rows("&eligibility=uncertain")).find((r) => r.id === held.id);
  assert.deepEqual([still.status, still.decision], ["proposed", "needs_eligibility_evidence"], "an explanation changes nothing about the record");
  assert.deepEqual(calls, ["readNotice", "judgeAliases", "explainRecord"]);
  const ai = await h.db.query<{ action: string }>("select action from audit_events where org_id = $1 and actor_kind = 'ai' order by id", [h.org]);
  assert.deepEqual([...new Set(ai.map((a) => a.action))].sort(), ["alias.opinion", "candidate.explained", "evidence.extracted"], "every use of the model is in the audit trail");
});
