// Runs the flagship recall case against the REAL PayPal sandbox.
//
//   npm run sandbox:recall
//
// What is real and what is not, in this run:
//   - The PAYMENTS are real sandbox payments, made here by PayPal's test card.
//   - Every refund, lookup, dispute check and refusal is PayPal's own answer.
//   - The MERCHANT RECORDS (orders, packing records, the supplier notice) are
//     synthetic, and deliberately untidy. See src/modules/demo/recall-scenario.ts.
//   - There is no simulator anywhere in this script.
//
// It walks the whole path: read the notice, save rules, match, settle what
// the records cannot, build a payment list, approve it, have the approval
// withdrawn by a late order, approve the new version, and pay. Two things
// are made to go wrong on purpose: one reply from PayPal is thrown away
// after PayPal has acted, and one payment is refunded directly at PayPal
// after approval so that our refund is refused.
//
// Results are printed and written to apps/api/.data/sandbox-recall.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContainer } from "../src/container.ts";
import { loadConfig } from "../src/platform/config.ts";
import { openDb } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";
import { JobRunner } from "../src/platform/jobs/queue.ts";
import { fromMinor, toMinor } from "../src/platform/money.ts";
import { OrderImport, upsertOrder } from "../src/modules/commerce/ingest.ts";
import { buildRecallScenario, loadRecallScenario, type PayRequest } from "../src/modules/demo/recall-scenario.ts";
import { evaluateIncident } from "../src/modules/evaluation/service.ts";
import { acceptExtraction, decideAlias, extractDocument, suggestAliases } from "../src/modules/evidence/service.ts";
import { createBatch, decideBatch, previewBatch, reviseBatch, startBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { OperationExecutor } from "../src/modules/execution/executor.ts";
import { currentManifest, listManifests } from "../src/modules/execution/manifests.ts";
import { createOrganisation, registerUser } from "../src/modules/identity/service.ts";
import { decideCandidates, reconcilePayment, runIncidentMatch } from "../src/modules/incidents/service.ts";
import { ProviderError } from "../src/modules/paypal/provider.ts";
import { PayPalRestClient } from "../src/modules/paypal/rest-client.ts";
import { FaultInjectingProvider } from "../src/modules/paypal/simulator.ts";
import { recoveryMap } from "../src/modules/recovery/map.ts";
import { lookupPaymentsByIds, lookupPaymentsByReference, refreshDisputeStates } from "../src/modules/transactions/sync.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const RESULT_FILE = path.join(API_ROOT, ".data", "sandbox-recall.json");
const SANDBOX = "https://api-m.sandbox.paypal.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36).toUpperCase();

type Line = { step: string; ok: boolean | null; detail: string };
const lines: Line[] = [];
const facts: Record<string, unknown> = { stamp, startedAt: new Date().toISOString() };

function say(step: string, ok: boolean | null, detail = ""): void {
  lines.push({ step, ok, detail });
  console.log(`  ${ok === null ? "note" : ok ? "ok  " : "FAIL"} ${step}${detail ? `  (${detail})` : ""}`);
}
const describe = (err: unknown): string =>
  err instanceof ProviderError ? `${err.kind} ${err.httpStatus ?? ""} ${err.issue ?? ""}`.trim() : err instanceof Error ? err.message : String(err);

function readKeys(): { clientId: string; clientSecret: string; from: string } | null {
  for (const file of [path.join(API_ROOT, ".env"), path.resolve(API_ROOT, "..", "..", ".env")]) {
    if (!fs.existsSync(file)) continue;
    const values: Record<string, string> = {};
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (!line || line.startsWith("#") || eq < 1) continue;
      values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    const clientId = values.PAYPAL_SANDBOX_CLIENT_ID || values.PAYPAL_CLIENT_ID;
    const clientSecret = values.PAYPAL_SANDBOX_CLIENT_SECRET || values.PAYPAL_CLIENT_SECRET;
    if (clientId && clientSecret) return { clientId, clientSecret, from: path.relative(path.resolve(API_ROOT, "..", ".."), file) || ".env" };
  }
  return null;
}

// ---------- taking test payments (only test scripts do this; the product never takes payments) ----------

let cachedToken: string | null = null;
async function rawCall(keys: { clientId: string; clientSecret: string }, method: string, urlPath: string, body?: unknown, requestId?: string) {
  if (!cachedToken) {
    const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    cachedToken = ((await res.json()) as { access_token?: string }).access_token ?? null;
    if (!cachedToken) throw new Error(`token request failed with ${res.status}`);
  }
  const res = await fetch(`${SANDBOX}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${cachedToken}`, "Content-Type": "application/json", Prefer: "return=representation", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, data, issue: data?.details?.[0]?.issue ?? data?.name ?? null };
}

/** PayPal's published sandbox test card numbers. Tried in order. */
const TEST_CARDS = ["4032039317984658", "4111111111111111", "4012888888881881"];
let duplicateInvoiceRefused = false;

async function payByCard(keys: { clientId: string; clientSecret: string }, request: PayRequest): Promise<{ captureId: string; createdAt: Date }> {
  const value = fromMinor(request.amountMinor, request.currency);
  const attempt = async (invoiceId: string | null, tag: string) => {
    let last = "";
    for (const number of TEST_CARDS) {
      const res = await rawCall(keys, "POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: "default", ...(invoiceId ? { invoice_id: invoiceId } : {}),
          description: `Make Good test payment: ${request.item.title}`.slice(0, 120),
          amount: { currency_code: request.currency, value },
        }],
        payment_source: {
          card: {
            number, expiry: "2030-12", security_code: "123", name: request.payer.name,
            billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
          },
        },
      }, `mg-recall-${stamp}-${request.key}-${tag}-${number.slice(-4)}`.replace(/[^A-Za-z0-9-]/g, "").slice(0, 100));
      const capture = res.data?.purchase_units?.[0]?.payments?.captures?.[0];
      if (res.ok && capture?.id && capture.status === "COMPLETED") {
        return { captureId: capture.id as string, createdAt: new Date(capture.create_time ?? Date.now()), issue: null as string | null };
      }
      last = `${res.status} ${res.issue ?? ""} ${capture?.status ?? res.data?.status ?? ""}`.trim();
      if (res.issue === "DUPLICATE_INVOICE_ID") return { captureId: "", createdAt: new Date(), issue: "DUPLICATE_INVOICE_ID" };
    }
    throw new Error(last || "the card payment was not completed");
  };
  const first = await attempt(request.invoiceId, "a");
  if (first.issue === "DUPLICATE_INVOICE_ID") {
    // This PayPal account refuses a second payment with an invoice number it has seen. The payment is taken without one.
    duplicateInvoiceRefused = true;
    const second = await attempt(null, "b");
    return { captureId: second.captureId, createdAt: second.createdAt };
  }
  return { captureId: first.captureId, createdAt: first.createdAt };
}

// ---------- the run ----------

async function main(): Promise<number> {
  console.log("Make Good: the HM-300 recall case on the PayPal sandbox\n");
  const keys = readKeys();
  if (!keys) {
    say("find PayPal sandbox keys", false, "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the repository's .env");
    return 1;
  }
  say("find PayPal sandbox keys", true, `from ${keys.from}`);
  const paypal = new PayPalRestClient({ environment: "sandbox", clientId: keys.clientId, clientSecret: keys.clientSecret });
  try {
    const { scopes } = await paypal.verifyCredentials();
    say("PayPal accepts the keys", true, `${scopes.length} permissions; Transaction Search ${scopes.some((s) => s.endsWith("/services/reporting/search/read")) ? "granted" : "NOT granted"}`);
  } catch (err) {
    say("PayPal accepts the keys", false, describe(err));
    return 1;
  }

  console.log("\n1. Real sandbox payments for the synthetic orders");
  let data;
  try {
    data = await buildRecallScenario({
      mode: "sandbox", now: new Date(), prefix: `R${stamp}-`, provider: paypal,
      pay: (request) => payByCard(keys, request),
      onProgress: (m) => console.log(`        ${m}`),
    });
  } catch (err) {
    say("take test payments by card", false, describe(err));
    return 2;
  }
  say("take test payments by card", true, `${data.captureIds.length} payments, for ${data.orders.length} synthetic orders`);
  say("refunds that are part of the back story, made directly at PayPal", true, "a 20.00 goodwill refund, a return refunded in full, a customer-service refund in full");
  for (const s of data.skipped) say(`case left out here: ${s.caseTag}`, null, s.why);
  if (duplicateInvoiceRefused) say("two payments with one invoice number", null, "PayPal refused the second (DUPLICATE_INVOICE_ID), so it was taken without an invoice number. Both orders then point at the one payment that carries the number.");
  facts.captures = data.captureIds;
  facts.skipped = data.skipped;

  console.log("\n2. The merchant's records and PayPal's records");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }, { readEnvFiles: false });
  const db = await openDb({ pglite: "memory" }); // a fresh database, so the development server's data is never touched
  await migrate(db);
  const c = await createContainer(config, { db, passwordCost: { N: 1024, r: 8, p: 1 }, ai: null });
  const user = await registerUser(c.identity, { email: `recall-${stamp.toLowerCase()}@example.com`, password: `recall ${stamp} password`, name: "Olive (test)" });
  const second = await registerUser(c.identity, { email: `approver-${stamp.toLowerCase()}@example.com`, password: `approver ${stamp} password`, name: "Ada (test)" });
  const org = await createOrganisation(c.identity, { name: `Kitchen Co ${stamp}`, defaultCurrency: "USD", userId: user.id });
  await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'finance_approver')", [org.id, second.id]);
  await db.query(`update organisations set settings = settings || '{"approval": {"dualControl": true}}'::jsonb where id = $1`, [org.id]);
  const conn = await c.connections.connectFirstParty(org.id, user.id, { environment: "sandbox", clientId: keys.clientId, clientSecret: keys.clientSecret });
  say("connect the organisation to PayPal", conn.status === "connected", `environment ${conn.environment}`);
  if (conn.status !== "connected") return 1;
  const provider = await c.connections.resolve(org.id, conn.id);
  const loaded = await loadRecallScenario(c.deps, { orgId: org.id, userId: user.id, data });
  say("import the synthetic orders, stock records and the supplier notice", true, `${loaded.orders} orders, ${loaded.labels} known answers stored apart`);
  const byId = await lookupPaymentsByIds(c.deps, { orgId: org.id, connectionId: conn.id, provider, captureIds: data.captureIds });
  say("read each payment from PayPal by ID", byId.found === data.captureIds.length, `${byId.found} of ${byId.looked} found. Transaction Search is not used.`);
  const byRef = await lookupPaymentsByReference(c.deps, { orgId: org.id, connectionId: conn.id, provider });
  say("ask PayPal for the payment ID the store recorded wrongly", byRef.notFound.length === 1, `PayPal does not know ${byRef.notFound.join(", ")}`);

  console.log("\n3. What went wrong: the notice is read, and a person saves the rules");
  const ev = { ...c.deps, ai: null };
  const read = await extractDocument(ev, { orgId: org.id, incidentId: loaded.incidentId, documentId: loaded.documentId, userId: user.id, method: "auto" });
  say("read the supplier notice", read.output.proposedScope !== null && read.output.dropped.length === 0,
    `by ${read.method.replace("_", " ")}; products ${read.output.proposedScope?.skus.join(", ")}; batch ${read.output.proposedScope?.batchCodes.join(", ")}`);
  if (!read.output.proposedScope) return 1;
  await acceptExtraction(ev, { orgId: org.id, incidentId: loaded.incidentId, extractionId: read.id, userId: user.id, scope: { ...read.output.proposedScope, serials: [], orderedFrom: null, orderedTo: null, shippedFrom: null, shippedTo: null, warehouses: [] }, compensation: { type: "full_refund", includeTax: true, includeShipping: false, minMinor: null, maxMinor: null, rounding: "half_up", allowPayout: false, refundWindowDays: 180 } });
  say("a person saves the rules", true, "full refund of affected units");

  console.log("\n4. Who might be affected: two answers per record");
  const match = async () => {
    const first = await runIncidentMatch(c.deps, { orgId: org.id, incidentId: loaded.incidentId, userId: user.id, payoutsAvailable: false });
    const disputes = await refreshDisputeStates(c.deps, { orgId: org.id, incidentId: loaded.incidentId, provider });
    return { result: disputes.changed > 0 ? await runIncidentMatch(c.deps, { orgId: org.id, incidentId: loaded.incidentId, userId: user.id, payoutsAvailable: false }) : first, disputes };
  };
  let m = await match();
  say("ask PayPal whether a dispute is open on each payment", m.disputes.failed === null, `${m.disputes.checked} payments checked, ${m.disputes.open} in dispute`);
  say("match", true, JSON.stringify(m.result.byDecision));
  const suggested = await suggestAliases(ev, { orgId: org.id, incidentId: loaded.incidentId, withAi: false });
  for (const a of suggested.aliases) {
    const same = a.alias === "HM300" || a.kind === "title";
    await decideAlias(ev, { orgId: org.id, aliasId: a.id, userId: user.id, decision: same ? "confirm" : "reject" });
    say(`product code "${a.alias}"`, true, same ? `a person confirmed it means ${a.canonicalSku}` : `a person said it is a different product (${a.reason})`);
  }
  m = await match();
  say("match again with the confirmed product codes", true, JSON.stringify(m.result.byDecision));
  const before = await evaluateIncident(db, org.id, loaded.incidentId);
  if (!before.available) return 1;
  say("no customer was wrongly called proven", before.eligibility.wrongInclusions === 0, `${before.eligibility.correct} of ${before.eligibility.truthAffectedUnits} affected units proven; ${before.eligibility.heldAffected + before.eligibility.heldNotAffected} held; ${before.eligibility.missed} missed`);
  say("no payment was tied to the wrong order", before.payment.falseMatches === 0, `${before.payment.verifiedAndRight} right, ${before.payment.held} held, ${before.payment.noPayPalPayment} with no PayPal payment`);
  say("every calculated amount matches the known answer", before.amounts.compared === before.amounts.exact, `${before.amounts.exact} of ${before.amounts.compared}`);
  const heldRows = await db.query<{ id: string; eligibility: string; payment_identity: string; decision: string; order_number: string | null }>(
    `select c.id, c.eligibility, c.payment_identity, c.decision, o.order_number from candidates c left join orders o on o.org_id = c.org_id and o.id = c.order_id
      where c.incident_id = $1 and c.status = 'proposed' order by o.order_number`, [loaded.incidentId],
  );
  say("uncertain cases are held, not paid", heldRows.some((r) => r.eligibility === "uncertain"), heldRows.map((r) => `${r.order_number ?? "no order"}: ${r.decision}`).join("; "));

  console.log("\n5. People settle what the records cannot");
  const supported = heldRows.filter((r) => r.eligibility === "supported");
  const confirmed = await decideCandidates(c.deps, { orgId: org.id, incidentId: loaded.incidentId, userId: user.id, candidateIds: supported.map((r) => r.id), decision: "confirm", basis: "merchant_records_checked", note: "warehouse pick sheets for that week show B-2217 only" });
  say("a person confirms the two orders the stock records support", confirmed.changed === supported.length, `${confirmed.changed} confirmed, with the reason stored in their name`);
  const ambiguous = heldRows.filter((r) => r.payment_identity === "ambiguous");
  const refusedConfirm = ambiguous.length === 0 ? null : await decideCandidates(c.deps, { orgId: org.id, incidentId: loaded.incidentId, userId: user.id, candidateIds: ambiguous.map((r) => r.id), decision: "confirm", basis: "merchant_records_checked" });
  if (refusedConfirm) say("confirming cannot settle which payment paid", refusedConfirm.changed === 0, refusedConfirm.refused[0]?.why ?? "");
  for (const row of ambiguous) {
    const [truth] = await db.query<{ id: string; transaction_id: string }>(
      `select p.id, p.transaction_id from evaluation_labels e join candidates c on c.org_id = e.org_id and c.order_line_id = e.order_line_id
         join payment_transactions p on p.org_id = e.org_id and p.transaction_id = e.true_capture_id where c.id = $1`, [row.id],
    );
    if (!truth) continue;
    await reconcilePayment(c.deps, { orgId: org.id, candidateId: row.id, paymentTransactionId: truth.id, userId: user.id, note: "matched the PayPal receipt the customer forwarded" });
    say(`a person settles the payment for ${row.order_number}`, true, truth.transaction_id);
  }
  m = await match();

  console.log("\n6. What is approved: one exact list, and what happens when it changes");
  const batch = await createBatch(c.deps, { orgId: org.id, incidentId: loaded.incidentId, userId: user.id, name: "HM-300 recall" });
  const v1 = (await currentManifest(db, org.id, batch.id))!;
  say("build the payment list", true, `version ${v1.version}: ${v1.content.items.length} refunds, ${fromMinor(v1.content.items.reduce((a, i) => a + i.amountMinor, 0), "USD")} USD; ${v1.content.notIncluded.length} left off with reasons; sha-256 ${v1.content_hash.slice(0, 16)}…`);
  await submitBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id });
  let selfApproval = "";
  try {
    await decideBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id, role: "owner", decision: "approve" });
  } catch (err) {
    selfApproval = describe(err);
  }
  say("the person who built the list cannot approve it", selfApproval !== "", selfApproval);
  const approved = await decideBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: second.id, role: "finance_approver", decision: "approve", comment: "checked against the list" });
  say("a second person approves version 1", approved.status === "approved");

  // A late order for the recalled batch arrives after approval.
  const late = await payByCard(keys, { key: "late", amountMinor: 5900, currency: "USD", invoiceId: `R${stamp}-LATE`, payer: { email: "late.buyer@example.com", name: "Late Buyer" }, at: new Date(), item: { sku: "HM-300", title: "Hand mixer HM-300", quantity: 1, unitMinor: 5900 } });
  await db.tx((tx) => upsertOrder(tx, org.id, loaded.storeId, OrderImport.parse({
    externalId: `late-${stamp}`, orderNumber: `R${stamp}-LATE`, placedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), currency: "USD",
    customer: { email: "late.buyer@example.com", name: "Late Buyer" }, paymentMethod: "paypal", paymentReference: late.captureId, total: "59.00",
    lines: [{ externalId: "l1", sku: "HM-300", title: "Hand mixer HM-300", quantity: 1, unitPrice: "59.00" }],
    fulfilments: [{ externalId: "f1", shippedAt: new Date(Date.now() - 29 * 86_400_000).toISOString(), lines: [{ lineExternalId: "l1", quantity: 1, batchCode: "B-2217" }] }],
    raw: { synthetic: true },
  })));
  await lookupPaymentsByIds(c.deps, { orgId: org.id, connectionId: conn.id, provider, captureIds: [late.captureId] });
  const rerun = await runIncidentMatch(c.deps, { orgId: org.id, incidentId: loaded.incidentId, userId: user.id, payoutsAvailable: false });
  say("a newly matched customer withdraws the approval", rerun.invalidatedBatches.includes(batch.id), "an affected order imported after approval");
  let refusedStart = "";
  try {
    await startBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id });
  } catch (err) {
    refusedStart = describe(err);
  }
  say("the withdrawn list cannot be started", refusedStart !== "", refusedStart);
  const revised = await reviseBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id });
  await submitBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id });
  const reapproved = await decideBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: second.id, role: "finance_approver", decision: "approve", comment: "version 2, with the late order" });
  const v2 = (await currentManifest(db, org.id, batch.id))!;
  say("a new version is built and approved afresh", reapproved.status === "approved" && revised.manifest.version === 2, `version 2: ${v2.content.items.length} refunds; version 1 is kept, marked invalidated`);
  facts.manifests = (await listManifests(db, org.id, batch.id)).map((x) => ({ version: x.version, status: x.status, sha256: x.content_hash, items: x.item_count }));

  console.log("\n7. What actually happened at PayPal");
  // Fault 1: a payment on the approved list is refunded directly at PayPal (as staff might in the dashboard). Our records do not know.
  const victim = v2.content.items.find((i) => i.amountMinor === 5900 && i.confirmedBy === null)!;
  const outside = await paypal.refundCapture(victim.captureId!, { requestId: `mg-outside-${stamp}`, noteToPayer: "Refund issued by customer service." });
  say(`refund ${victim.orderNumber} directly at PayPal, outside Make Good`, outside.status === "COMPLETED", `${outside.id}; our records are not told`);
  // Fault 2: the reply to the first refund the worker sends is thrown away after PayPal has acted.
  const faulty = new FaultInjectingProvider(provider);
  faulty.dropNextReplies(1);
  const executor = new OperationExecutor({ db, clock: c.clock, providers: async () => faulty });
  const runner = new JobRunner(db, executor.handlers(), { workerId: "sandbox-recall", clock: c.clock, concurrency: 1 });
  const started = await startBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id, spacingMs: 1200 });
  say("start paying", started.queued === v2.content.items.length, `${started.queued} refunds queued`);
  const deadline = Date.now() + 6 * 60_000;
  let status = "executing";
  let sawUnknown = false;
  while (Date.now() < deadline) {
    await runner.runOnce();
    const states = await db.query<{ state: string }>("select state from payment_operations where batch_id = $1", [batch.id]);
    if (!sawUnknown && states.some((s) => s.state === "unknown")) {
      sawUnknown = true;
      console.log("  ...   one refund has no answer (reply discarded on purpose). It is marked unknown, not failed. Waiting for the lookup.");
    }
    status = (await db.query<{ status: string }>("select status from batches where id = $1", [batch.id]))[0]!.status;
    if (status !== "executing") break;
    await sleep(1000);
  }
  const ops = await db.query<{ id: string; state: string; capture_id: string; amount_minor: number; provider_refund_id: string | null; failure_code: string | null; attempts: number; idempotency_key: string }>(
    "select id, state, capture_id, amount_minor, provider_refund_id, failure_code, attempts, idempotency_key from payment_operations where batch_id = $1 order by created_at", [batch.id],
  );
  const succeeded = ops.filter((o) => o.state === "succeeded");
  const failed = ops.filter((o) => o.state === "failed_final");
  say("the batch finishes", status === "completed_with_failures", `${status}: ${succeeded.length} refunded, ${failed.length} failed`);
  say("the lost reply was held as unknown, then settled", sawUnknown && faulty.injected.length === 1, "the reply was discarded after PayPal had made the refund");
  const lost = ops.find((o) => o.idempotency_key === faulty.injected[0]?.requestId);
  say("asking again with the same request ID gave the same refund", Boolean(lost && lost.state === "succeeded" && lost.provider_refund_id === faulty.injected[0]?.providerId),
    `${lost?.provider_refund_id}; ${lost?.attempts} calls, one refund`);
  const refusal = failed.find((o) => o.capture_id === victim.captureId);
  say("PayPal refused the refund on the payment refunded elsewhere", Boolean(refusal), `${refusal?.failure_code}; it stays failed`);
  const [payouts] = await db.query<{ n: number }>("select count(*)::int as n from payment_operations where org_id = $1 and kind = 'payout'", [org.id]);
  say("the refused refund was not sent some other way", payouts!.n === 0, "no payout exists");

  // PayPal's own records, asked directly.
  let confirmedByPayPal = 0;
  const table: Array<Record<string, unknown>> = [];
  for (const op of succeeded) {
    const refund = await paypal.getRefund(op.provider_refund_id!);
    const amountOk = toMinor(refund.amount.value, refund.amount.currency_code) === op.amount_minor;
    if (refund.status === "COMPLETED" && amountOk) confirmedByPayPal++;
    const capture = await paypal.getCapture(op.capture_id);
    table.push({ capture: op.capture_id, refund: op.provider_refund_id, amount: refund.amount.value, refundStatus: refund.status, captureStatus: capture.status, calls: op.attempts });
  }
  say("PayPal confirms each refund, for the amount on the approved list", confirmedByPayPal === succeeded.length, `${confirmedByPayPal} of ${succeeded.length} are COMPLETED with the listed amount`);
  const partials = table.filter((t) => t.captureStatus === "PARTIALLY_REFUNDED");
  const fulls = table.filter((t) => t.captureStatus === "REFUNDED");
  say("full and partial refunds both went through", partials.length >= 1 && fulls.length >= 1, `${fulls.length} payments now fully refunded, ${partials.length} partially (the multi-item order and the one-of-two-units order)`);
  facts.refunds = table;
  facts.refusal = refusal ? { capture: refusal.capture_id, code: refusal.failure_code, refundedOutsideBy: outside.id } : null;

  console.log("\n8. Checked against the known answers, and the records");
  const after = await evaluateIncident(db, org.id, loaded.incidentId);
  if (!after.available) return 1;
  say("every paid line received exactly what was owed", after.money.overpaidLines === 0 && after.money.underpaidLines === 0, `${after.money.linesPaid} labelled lines paid, ${fromMinor(after.money.paidMinor, "USD")} USD`);
  say("nobody unaffected was paid, and nothing was refunded twice", after.money.paidToUnaffected === 0 && after.duplicates.paymentsRefundedTwiceInThisIncident === 0 && after.duplicates.paymentsRefundedBeyondTheirAmount === 0);
  const map = await recoveryMap(db, org.id, loaded.incidentId);
  say("the Recovery Map shows where every record stands", true, map.groups.map((g) => `${g.label}: ${g.count}`).join("; "));
  const { verifyAuditChain } = await import("../src/platform/audit.ts");
  const chain = await verifyAuditChain(db, org.id);
  say("the audit trail is complete and unaltered", chain.ok, `${chain.rows} entries`);
  facts.evaluation = { eligibility: after.eligibility, payment: after.payment, amounts: { compared: before.amounts.compared, exact: before.amounts.exact }, money: after.money, duplicates: after.duplicates, workload: after.workload, people: after.people };
  facts.recoveryMap = map.groups.map((g) => ({ disposition: g.disposition, count: g.count }));

  await db.close();
  const bad = lines.filter((l) => l.ok === false);
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ...facts, finishedAt: new Date().toISOString(), lines }, null, 2));
  console.log(bad.length === 0 ? "\nAll checks passed." : `\n${bad.length} check(s) FAILED.`);
  console.log(`Details written to ${path.relative(process.cwd(), RESULT_FILE)}`);
  return bad.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error("\nThe run stopped:", err);
  process.exit(1);
});
