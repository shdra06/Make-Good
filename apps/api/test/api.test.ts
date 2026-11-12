// Tests of the HTTP API as a client sees it: sign-in, tenant isolation, roles,
// and whole workflows driven only through routes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/api/routes.ts";
import { createContainer, type Container } from "../src/container.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { loadConfig } from "../src/platform/config.ts";
import type { Email, Mailer } from "../src/modules/notify/mailer.ts";
import { testDb } from "./helpers.ts";

type Reply = { status: number; body: any; headers: Record<string, unknown> };

/** Stands in for the outside world: PayPal's token endpoint and the exchange-rate source. */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v1/oauth2/token")) {
    return jsonReply({
      access_token: "test-token", expires_in: 3600,
      scope: "https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/reporting/search/read https://uri.paypal.com/payments/payouts",
    });
  }
  if (url.includes("/latest?base=")) {
    const base = new URL(url).searchParams.get("base");
    const table: Record<string, Record<string, number>> = { EUR: { USD: 1.1214 }, GBP: { USD: 1.3423 }, JPY: { USD: 0.006322 } };
    return jsonReply({ amount: 1, base, date: "2026-11-10", rates: table[base ?? ""] ?? {} });
  }
  if (url.includes("..")) return jsonReply({ base: "USD", rates: { "2026-11-09": { EUR: 0.89342 }, "2026-11-10": { EUR: 0.89174 } } });
  return jsonReply({ error: "unexpected call in a test", url }, 500);
};

async function harness() {
  const db = await testDb();
  const clock = new FakeClock("2026-11-10T09:00:00.000Z");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000" }, { readEnvFiles: false });
  // Emails stay in memory, so tests can open the links in them.
  const outbox: Email[] = [];
  const mailer: Mailer = { transport: "file", send: async (email) => (outbox.push(email), { ref: `memory/${email.id}` }) };
  const container: Container = await createContainer(config, { db, clock, fetchImpl: fakeFetch, passwordCost: { N: 1024, r: 8, p: 1 }, mailer });
  const { app, openapi } = buildApp(container);
  await app.ready();

  function client() {
    let cookie = "";
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
      const res = await app.inject({
        method: method as "GET", url, payload: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-make-good": "1" }), ...(cookie ? { cookie } : {}), ...headers },
      });
      const set = res.headers["set-cookie"];
      if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
      let parsed: unknown = null;
      try {
        parsed = res.body ? JSON.parse(res.body) : null;
      } catch {
        parsed = res.body;
      }
      return { status: res.statusCode, body: parsed, headers: res.headers };
    };
    return {
      get: (url: string) => call("GET", url),
      post: (url: string, body: unknown = {}, headers?: Record<string, string>) => call("POST", url, body, headers),
      patch: (url: string, body: unknown) => call("PATCH", url, body),
      del: (url: string) => call("DELETE", url),
      call,
    };
  }

  /** Registers a user and, optionally, gives them an organisation of their own. */
  async function person(name: string, orgName?: string) {
    const c = client();
    const email = `${name.toLowerCase()}@example.com`;
    const reg = await c.post("/api/auth/register", { email, password: "correct horse battery", name });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    let orgId = "";
    if (orgName) {
      const org = await c.post("/api/orgs", { name: orgName });
      assert.equal(org.status, 200, JSON.stringify(org.body));
      orgId = org.body.id;
    }
    return { ...c, email, orgId };
  }
  return { db, clock, container, app, openapi, client, person, outbox };
}

const RECALL_RULES = {
  scope: { type: "product", skus: ["CM-412"], batchCodes: ["LOT-24B"] },
  compensation: { type: "full_refund" },
};

test("accounts: register, sign in, sign out, and wrong passwords", async () => {
  const h = await harness();
  const anon = h.client();
  assert.equal((await anon.get("/api/me")).status, 401);
  assert.equal((await anon.post("/api/auth/register", { email: "x@example.com", password: "short", name: "X" })).status, 422);

  const ada = await h.person("Ada", "Emberline Ceramics");
  const me = await ada.get("/api/me");
  assert.equal(me.body.user.email, "ada@example.com");
  assert.equal(me.body.organisations[0].role, "owner");
  assert.ok(me.body.organisations[0].permissions.includes("batch.approve"));
  assert.equal(JSON.stringify(me.body).includes("password"), false);

  assert.equal((await anon.post("/api/auth/register", { email: "ADA@example.com", password: "another long password", name: "Imposter" })).status, 409);
  assert.equal((await anon.post("/api/auth/login", { email: "ada@example.com", password: "wrong password here" })).status, 401);
  assert.equal((await anon.post("/api/auth/login", { email: "nobody@example.com", password: "wrong password here" })).status, 401);
  assert.equal((await anon.post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" })).status, 200);
  assert.equal((await anon.get("/api/me")).status, 200);
  await anon.post("/api/auth/logout");
  assert.equal((await anon.get("/api/me")).status, 401, "the session is revoked on the server, not only forgotten by the browser");

  const [stored] = await h.db.query<{ password_hash: string; token_hash: string }>(
    "select u.password_hash, s.token_hash from users u join sessions s on s.user_id = u.id limit 1",
  );
  assert.match(stored!.password_hash, /^scrypt\$/);
  assert.equal(stored!.token_hash.length, 64, "only a hash of the session token is stored");
});

test("sign-in is rate limited", async () => {
  const h = await harness();
  await h.person("Ada");
  const anon = h.client();
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await anon.post("/api/auth/login", { email: "ada@example.com", password: "wrong password here" })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

test("tenant isolation: no organisation route answers for someone else's organisation", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const mallory = await h.person("Mallory", "Other Shop");
  await ada.post(`/api/orgs/${ada.orgId}/paypal/simulator`);
  await ada.post(`/api/orgs/${ada.orgId}/demo/seed`);
  const incident = await ada.post(`/api/orgs/${ada.orgId}/incidents`, { kind: "recall", title: "CM-412 recall" });

  const spec = h.openapi() as { paths: Record<string, Record<string, unknown>> };
  const filler = "00000000-0000-4000-8000-000000000000";
  let checked = 0;
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.includes("{orgId}")) continue;
    for (const method of Object.keys(methods)) {
      const url = path
        .replace("{orgId}", ada.orgId)
        .replace("{incidentId}", incident.body.id)
        .replace(/\{[A-Za-z]+\}/g, filler);
      const res = await mallory.call(method.toUpperCase(), url, method === "get" || method === "delete" ? undefined : {});
      assert.equal(res.status, 404, `${method.toUpperCase()} ${path} answered ${res.status} to a member of another organisation`);
      checked++;
    }
  }
  assert.ok(checked >= 40, `only ${checked} organisation routes were checked`);

  // And a real ID from one organisation is not found through another.
  const own = await mallory.get(`/api/orgs/${mallory.orgId}/incidents/${incident.body.id}`);
  assert.equal(own.status, 404);
  assert.equal((await mallory.get(`/api/orgs/${mallory.orgId}/orders`)).body.total, 0);
});

test("roles: each person can do their job and no more", async () => {
  const h = await harness();
  const owner = await h.person("Olga", "Emberline Ceramics");
  const org = owner.orgId;
  const viewer = await h.person("Vik");
  const operator = await h.person("Omar");
  const approver = await h.person("Fay");
  for (const [who, role] of [[viewer, "viewer"], [operator, "operator"], [approver, "finance_approver"]] as const) {
    assert.equal((await owner.post(`/api/orgs/${org}/members`, { email: who.email, role })).status, 200);
  }
  assert.equal((await owner.post(`/api/orgs/${org}/members`, { email: "ghost@example.com", role: "viewer" })).status, 422);
  assert.equal((await operator.post(`/api/orgs/${org}/members`, { email: viewer.email, role: "admin" })).status, 403);
  assert.equal((await owner.post(`/api/orgs/${org}/members`, { email: owner.email, role: "viewer" })).status, 409, "the last owner cannot be removed");

  await owner.post(`/api/orgs/${org}/paypal/simulator`);
  await owner.post(`/api/orgs/${org}/demo/seed`);
  assert.equal((await viewer.get(`/api/orgs/${org}/dashboard`)).status, 200);
  assert.equal((await viewer.post(`/api/orgs/${org}/incidents`, { kind: "recall", title: "Nope nope" })).status, 403);
  assert.equal((await viewer.get(`/api/orgs/${org}/audit`)).status, 403);
  assert.equal((await operator.post(`/api/orgs/${org}/paypal/simulator`)).status, 403);

  const incident = await operator.post(`/api/orgs/${org}/incidents`, { kind: "recall", title: "CM-412 recall" });
  assert.equal(incident.status, 200);
  await operator.post(`/api/orgs/${org}/incidents/${incident.body.id}/rules`, RECALL_RULES);
  await operator.post(`/api/orgs/${org}/incidents/${incident.body.id}/match`);
  const batch = await operator.post(`/api/orgs/${org}/incidents/${incident.body.id}/batches`, { name: "Recall batch" });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  await operator.post(`/api/orgs/${org}/batches/${batch.body.id}/submit`);
  assert.equal((await operator.post(`/api/orgs/${org}/batches/${batch.body.id}/decision`, { decision: "approve" })).status, 403, "an operator cannot approve payments");
  assert.equal((await approver.post(`/api/orgs/${org}/incidents`, { kind: "recall", title: "Not my job" })).status, 403);
  const decided = await approver.post(`/api/orgs/${org}/batches/${batch.body.id}/decision`, { decision: "approve" });
  assert.equal(decided.body.status, "approved");
});

test("a request from another website is refused", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const res = await ada.post(`/api/orgs/${ada.orgId}/paypal/simulator`, {}, { origin: "https://evil.example" });
  assert.equal(res.status, 403);
  const ok = await ada.post(`/api/orgs/${ada.orgId}/paypal/simulator`, {}, { origin: "http://localhost:4000" });
  assert.equal(ok.status, 200);
});

test("a request that changes something must carry the anti-forgery header", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const url = `/api/orgs/${ada.orgId}/paypal/simulator`;
  const missing = await ada.call("POST", url, {}, { "x-make-good": "" });
  assert.equal(missing.status, 403);
  assert.match(missing.body.error.message, /x-make-good/);
  assert.equal((await ada.call("POST", url, {}, { "x-make-good": "1" })).status, 200);
  const anon = h.client();
  assert.equal((await anon.call("POST", "/api/auth/login", { email: "ada@example.com", password: "correct horse battery" }, { "x-make-good": "" })).status, 403,
    "a forged sign-in into the attacker's account is refused too");
  const health = await anon.get("/api/health");
  assert.match(String(health.headers["content-security-policy"]), /default-src 'none'/);
});

const linkToken = (email: Email, path: string) => email.text.split(`/${path}/`)[1]!.split(/\s/)[0]!;

test("email verification: a link is sent on sign-up and works once", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  assert.equal((await ada.get("/api/me")).body.user.emailVerified, false);
  const sent = h.outbox.filter((e) => e.to === "ada@example.com" && e.subject.includes("Confirm your email"));
  assert.equal(sent.length, 1);
  const token = linkToken(sent[0]!, "verify-email");
  assert.equal(JSON.stringify(await h.db.query("select token_hash from account_tokens")).includes(token), false, "only the hash is stored");

  const anon = h.client();
  assert.equal((await anon.post("/api/auth/verify-email/confirm", { token })).status, 200);
  assert.equal((await ada.get("/api/me")).body.user.emailVerified, true);
  assert.equal((await anon.post("/api/auth/verify-email/confirm", { token })).status, 422, "a used link does not work again");
  assert.equal((await ada.post("/api/auth/verify-email")).body.alreadyVerified, true);
});

test("email verification: a resent link expires and the resend is limited", async () => {
  const h = await harness();
  const bo = await h.person("Bo");
  for (let i = 0; i < 2; i++) assert.equal((await bo.post("/api/auth/verify-email")).status, 200);
  assert.equal((await bo.post("/api/auth/verify-email")).status, 409, "three links an hour at most, counting the one sent on sign-up");
  const last = h.outbox.filter((e) => e.to === "bo@example.com").at(-1)!;
  h.clock.advance(49 * 60 * 60_000);
  assert.equal((await bo.post("/api/auth/verify-email/confirm", { token: linkToken(last, "verify-email") })).status, 422, "expired after 48 hours");
});

test("password reset: same reply for unknown emails, one-time link, every session signed out", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const anon = h.client();
  const before = h.outbox.length;
  const unknown = await anon.post("/api/auth/password-reset", { email: "nobody@example.com" });
  assert.equal(unknown.status, 200);
  assert.equal(h.outbox.length, before, "no email for an account that does not exist");
  const known = await anon.post("/api/auth/password-reset", { email: "ADA@example.com" });
  assert.deepEqual(known.body, unknown.body, "the reply does not say whether the account exists");
  const mail = h.outbox.at(-1)!;
  assert.equal(mail.to, "ada@example.com");
  const token = linkToken(mail, "reset-password");

  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token, password: "short" })).status, 422);
  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token, password: "a brand new passphrase" })).status, 200);
  assert.equal((await ada.get("/api/me")).status, 401, "the old session is signed out");
  assert.equal((await anon.post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" })).status, 401);
  assert.equal((await anon.post("/api/auth/login", { email: "ada@example.com", password: "a brand new passphrase" })).status, 200);
  assert.equal((await anon.get("/api/me")).body.user.emailVerified, true, "the reset link proved the address");
  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token, password: "yet another passphrase" })).status, 422, "the link works once");

  await anon.post("/api/auth/password-reset", { email: "ada@example.com" });
  const later = linkToken(h.outbox.at(-1)!, "reset-password");
  h.clock.advance(61 * 60_000);
  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token: later, password: "yet another passphrase" })).status, 422, "expired after an hour");
});

test("a recall, start to finish, through the API", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const org = ada.orgId;

  const conn = await ada.post(`/api/orgs/${org}/paypal/simulator`);
  assert.equal(conn.body.environment, "simulator");
  const seeded = await ada.post(`/api/orgs/${org}/demo/seed`);
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  assert.equal((await ada.post(`/api/orgs/${org}/demo/seed`)).status, 409, "sample data is loaded once");
  assert.equal((await ada.get(`/api/orgs/${org}`)).body.settings.demoData, true, "the organisation is marked as holding sample data");

  const orders = await ada.get(`/api/orgs/${org}/orders?search=CM-412&size=5`);
  assert.ok(orders.body.total > 40);
  assert.equal(orders.body.rows.length, 5);
  const payments = await ada.get(`/api/orgs/${org}/payments?kind=payment&size=3`);
  assert.ok(payments.body.rows.every((p: any) => p.transaction_id.startsWith("SIM") && p.environment === "simulator"), "sample payments are marked as simulated");

  const incident = await ada.post(`/api/orgs/${org}/incidents`, { kind: "recall", title: "CM-412 batch LOT-24B fails a lead test" });
  const id = incident.body.id;
  assert.equal((await ada.post(`/api/orgs/${org}/incidents/${id}/match`)).status, 422, "matching needs rules first");
  assert.equal((await ada.post(`/api/orgs/${org}/incidents/${id}/rules`, { scope: { type: "product", skus: [] }, compensation: { type: "full_refund" } })).status, 422);
  const rules = await ada.post(`/api/orgs/${org}/incidents/${id}/rules`, RECALL_RULES);
  assert.equal(rules.body.version, 1);

  const match = await ada.post(`/api/orgs/${org}/incidents/${id}/match`);
  assert.equal(match.status, 200, JSON.stringify(match.body));
  const by = match.body.stats.byClassification;
  assert.equal(by.exact_unit, 20, "14 plain + 1 partly returned + 1 paid by card + 4 abroad, each with the batch on the packing record");
  assert.equal(by.strong_multi_source, 5, "shipped while only the affected batch was going out");
  assert.equal(by.likely, 6, "shipped while two batches overlapped");
  assert.equal(by.product_only, 1, "no shipping record at all");
  assert.equal(match.body.stats.excluded.returned, 1);
  assert.equal(match.body.stats.clearedByBatchRecord, 16);

  const strong = await ada.get(`/api/orgs/${org}/incidents/${id}/candidates?classification=strong_multi_source`);
  assert.equal(strong.body.total, 5);
  const detail = await ada.get(`/api/orgs/${org}/candidates/${strong.body.rows[0].id}`);
  assert.ok(detail.body.evidence.some((e: any) => e.source === "inventory_batch"), "the inventory record is cited");
  assert.equal(detail.body.calculation.route, "refund_original");
  assert.ok(detail.body.calculation.steps.steps.some((s: any) => s.label === "Line price"), "the calculation is shown step by step");
  assert.equal("confirm_token_hash" in detail.body.candidate, false);

  // Before any decision, only customers proven by a packing record can be paid.
  const before = await ada.get(`/api/orgs/${org}/incidents/${id}/preview`);
  assert.equal(before.body.totals.count, 19, "20 exact, less the customer who paid by card");
  assert.equal(before.body.notIncluded.waiting_for_confirmation, 12);
  assert.equal(before.body.notIncluded.needs_manual_handling, 1, "the card payer is left for a person");
  assert.deepEqual(Object.keys(before.body.totals.byCurrency).sort(), ["EUR", "GBP", "JPY", "USD"]);

  // The merchant reviews the five inventory-backed customers and confirms them.
  const decided = await ada.post(`/api/orgs/${org}/incidents/${id}/candidates/decide`, { candidateIds: strong.body.rows.map((r: any) => r.id), decision: "confirm" });
  assert.equal(decided.body.changed, 5);
  const preview = await ada.get(`/api/orgs/${org}/incidents/${id}/preview`);
  assert.equal(preview.body.totals.count, 24);

  const batch = await ada.post(`/api/orgs/${org}/incidents/${id}/batches`, { name: "Recall LOT-24B" });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.equal((await ada.post(`/api/orgs/${org}/batches/${batch.body.id}/start`)).status, 409, "an unapproved batch cannot start");
  await ada.post(`/api/orgs/${org}/batches/${batch.body.id}/submit`);
  assert.equal((await ada.post(`/api/orgs/${org}/batches/${batch.body.id}/decision`, { decision: "approve", comment: "checked" })).body.status, "approved");
  assert.equal((await ada.post(`/api/orgs/${org}/batches/${batch.body.id}/start`)).body.queued, 24);

  // The worker pays them.
  for (let i = 0; i < 40; i++) {
    await h.container.runner.drain();
    h.clock.advance(1000);
  }
  const done = await ada.get(`/api/orgs/${org}/batches/${batch.body.id}`);
  assert.equal(done.body.batch.status, "completed");
  assert.equal(done.body.totalOperations, 24);
  assert.ok(done.body.operations.every((o: any) => o.state === "succeeded" && o.provider_refund_id.startsWith("SIMREF")));
  const attempts = await ada.get(`/api/orgs/${org}/operations/${done.body.operations[0].id}/attempts`);
  assert.equal(attempts.body.length, 1);
  assert.equal(attempts.body[0].outcome, "accepted");

  const sim = await h.container.connections.simulatorFor(org);
  assert.equal(sim.refunds.size, 24);
  const refunds = await ada.get(`/api/orgs/${org}/payments?kind=refund`);
  assert.equal(refunds.body.total, 24);

  const dash = await ada.get(`/api/orgs/${org}/dashboard`);
  assert.equal(dash.body.operations.filter((o: any) => o.state === "succeeded").reduce((a: number, o: any) => a + o.n, 0), 24);
  const audit = await ada.get(`/api/orgs/${org}/audit?size=200`);
  assert.equal(audit.body.chain.ok, true, "the audit chain is intact");
  assert.ok(audit.body.rows.some((r: any) => r.action === "batch.approve"));
  assert.ok(audit.body.rows.some((r: any) => r.action === "operation.succeeded"));
  assert.equal((await ada.get(`/api/orgs/${org}/analytics`)).body.byIncident[0].paid, 24);
});

test("monitoring finds the double charges, and one click turns them into a refund batch", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const org = ada.orgId;
  await ada.post(`/api/orgs/${org}/paypal/simulator`);
  await ada.post(`/api/orgs/${org}/demo/seed`);

  const run = await ada.post(`/api/orgs/${org}/detections/run`);
  assert.equal(run.body.raised, 3);
  assert.equal((await ada.post(`/api/orgs/${org}/detections/run`)).body.raised, 0, "the same finding is not raised twice");
  const found = await ada.get(`/api/orgs/${org}/detections?status=open`);
  assert.equal(found.body.findings.length, 3);
  assert.ok(found.body.findings.every((f: any) => f.detector === "duplicate_charge" && f.severity === "critical"));
  assert.ok(found.body.detectors.length >= 6, "each detector states what it needs and what it cannot see");

  const converted = await ada.post(`/api/orgs/${org}/detections/${found.body.findings[0].id}/convert`);
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  const id = converted.body.incidentId;
  const match = await ada.post(`/api/orgs/${org}/incidents/${id}/match`);
  assert.equal(match.body.stats.byClassification.exact_unit, 3, "one incident covers all three double charges");
  const preview = await ada.get(`/api/orgs/${org}/incidents/${id}/preview`);
  assert.equal(preview.body.totals.byCurrency.USD.amountMinor, 3 * 3900, "each duplicate payment, whole, once");
  assert.equal((await ada.get(`/api/orgs/${org}/detections?status=open`)).body.findings.length, 0, "all three findings now point at the incident");
  assert.equal((await ada.post(`/api/orgs/${org}/detections/${found.body.findings[0].id}/convert`)).status, 409);
});

test("currency exposure is reported with indicative rates and clear warnings", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const org = ada.orgId;
  await ada.post(`/api/orgs/${org}/paypal/simulator`);
  await ada.post(`/api/orgs/${org}/demo/seed`);
  const incident = await ada.post(`/api/orgs/${org}/incidents`, { kind: "recall", title: "CM-412 recall" });
  await ada.post(`/api/orgs/${org}/incidents/${incident.body.id}/rules`, RECALL_RULES);
  await ada.post(`/api/orgs/${org}/incidents/${incident.body.id}/match`);

  const exposure = await ada.get(`/api/orgs/${org}/fx/exposure`);
  assert.equal(exposure.status, 200, JSON.stringify(exposure.body));
  const eur = exposure.body.byCurrency.find((c: any) => c.currency === "EUR");
  assert.equal(eur.owedMinor, 11800, "two customers in Germany and France at 59.00 EUR");
  assert.equal(eur.estimatedInOrgCurrencyMinor, 13233, "118.00 EUR x 1.1214 = 132.33 USD");
  assert.match(eur.indicativeRate.source, /Not PayPal's rate/);
  assert.equal(eur.estimatedConversionCostMinor, null, "no cost estimate until the merchant states an assumption");
  const jpy = exposure.body.byCurrency.find((c: any) => c.currency === "JPY");
  assert.equal(jpy.owedMinor, 8850);
  assert.equal(jpy.estimatedInOrgCurrencyMinor, 5595, "8850 JPY x 0.006322 = 55.95 USD, across different decimal places");
  assert.equal(exposure.body.byCurrency.find((c: any) => c.currency === "USD").indicativeRate, null);

  await ada.patch(`/api/orgs/${org}/settings`, { fxAssumedSpreadBps: 400 });
  const withCost = await ada.get(`/api/orgs/${org}/fx/exposure`);
  assert.equal(withCost.body.byCurrency.find((c: any) => c.currency === "EUR").estimatedConversionCostMinor, 529, "4% of 132.33");
  assert.ok(withCost.body.notes.some((n: string) => /your own assumption/.test(n)));

  const history = await ada.get("/api/fx/history?base=USD&quote=EUR&days=30");
  assert.equal(history.body.points.length, 2);
  assert.match(history.body.disclaimer, /Not the rate PayPal applies/);
});

test("PayPal credentials are encrypted at rest and never returned", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const secret = "ELtopsecretvalue1234567890abcdefghijklmnopqrstuvwxyz";
  const res = await ada.post(`/api/orgs/${ada.orgId}/paypal/credentials`, { environment: "sandbox", clientId: "AYclientidvalue1234567890abcdefghij", clientSecret: secret });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "connected");
  assert.equal(res.body.capabilities.refunds, true);
  assert.equal(res.body.capabilities.disputes, false, "a permission PayPal did not grant is reported as missing");
  assert.equal(JSON.stringify(res.body).includes(secret), false);
  assert.match(res.body.clientIdMasked, /^\*+efghij$/);

  const [row] = await h.db.query<{ secret_ciphertext: string }>("select secret_ciphertext from paypal_connections where org_id = $1", [ada.orgId]);
  assert.ok(row!.secret_ciphertext.startsWith("v1.k1."));
  assert.equal(row!.secret_ciphertext.includes(secret), false);
  assert.equal(h.container.secrets.decrypt(row!.secret_ciphertext), secret);
  const audit = await h.db.query<{ data: unknown }>("select data from audit_events where action = 'paypal.connection_saved'");
  assert.equal(JSON.stringify(audit).includes(secret), false, "the secret is not in the audit trail");

  assert.equal((await ada.post(`/api/orgs/${ada.orgId}/paypal/credentials`, { environment: "live", clientId: "AYclientidvalue1234567890abcdefghij", clientSecret: secret })).status, 403, "live is refused on this server");
  assert.equal((await ada.post(`/api/orgs/${ada.orgId}/paypal/partner-onboarding`, {})).status, 503, "partner onboarding says plainly that it needs approval");

  const list = await ada.get(`/api/orgs/${ada.orgId}/paypal`);
  await ada.del(`/api/orgs/${ada.orgId}/paypal/${list.body.connections[0].id}`);
  const [after] = await h.db.query<{ secret_ciphertext: string | null; status: string }>("select secret_ciphertext, status from paypal_connections where org_id = $1", [ada.orgId]);
  assert.deepEqual(after, { secret_ciphertext: null, status: "revoked" });
});

test("webhooks: stored once, acted on only when PayPal confirms the signature", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const org = ada.orgId;
  const conn = await ada.post(`/api/orgs/${org}/paypal/simulator`);
  await ada.post(`/api/orgs/${org}/demo/seed`);
  const [payment] = (await ada.get(`/api/orgs/${org}/payments?kind=payment&size=1`)).body.rows;
  const event = (id: string) => ({
    id, event_type: "CUSTOMER.DISPUTE.CREATED", resource_type: "dispute",
    resource: { dispute_id: "PP-D-1", disputed_transactions: [{ seller_transaction_id: payment.transaction_id }] },
  });
  const anon = h.client();
  const url = `/api/webhooks/paypal/${conn.body.id}`;
  const disputeState = async () =>
    (await h.db.query<{ dispute_state: string | null }>("select dispute_state from payment_transactions where transaction_id = $1", [payment.transaction_id]))[0]!.dispute_state;

  // No webhook ID is configured, so nothing can be verified and nothing is acted on.
  assert.equal((await anon.post(url, event("WH-1"))).status, 200);
  await h.container.runner.drain();
  assert.equal(await disputeState(), null);

  await h.db.query("update paypal_connections set webhook_id = 'WH-ID-1', updated_at = now() where id = $1", [conn.body.id]);
  // A forged event with a bad signature: stored for inspection, not acted on.
  await anon.post(url, event("WH-2"), { "paypal-transmission-sig": "forged" });
  await h.container.runner.drain();
  assert.equal(await disputeState(), null);

  // A genuine one, delivered twice.
  const first = await anon.post(url, event("WH-3"), { "paypal-transmission-sig": "simulator-valid" });
  const second = await anon.post(url, event("WH-3"), { "paypal-transmission-sig": "simulator-valid" });
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  await h.container.runner.drain();
  assert.equal(await disputeState(), "open");

  const events = await h.db.query<{ event_id: string; verified: boolean; processing_result: string | null }>("select event_id, verified, processing_result from provider_events order by received_at");
  assert.deepEqual(events.map((e) => [e.event_id, e.verified]), [["WH-1", false], ["WH-2", false], ["WH-3", true]]);
  assert.equal((await anon.post("/api/webhooks/paypal/00000000-0000-4000-8000-000000000000", event("WH-4"))).status, 404);
});

test("the API describes itself", async () => {
  const h = await harness();
  const res = await h.client().get("/api/openapi.json");
  assert.equal(res.status, 200);
  assert.equal(res.body.openapi, "3.1.0");
  assert.ok(Object.keys(res.body.paths).length >= 45);
  const rules = res.body.paths["/api/orgs/{orgId}/incidents/{incidentId}/rules"].post;
  assert.equal(rules["x-permission"], "incident.write");
  assert.ok(rules.requestBody.content["application/json"].schema.properties.scope, "request bodies carry their schema");
  assert.equal((await h.client().get("/api/health")).body.ok, true);
});

test("rate limits are kept in the database, so a second server process sees the same count", async () => {
  const h = await harness();
  const anon = h.client();
  for (let i = 0; i < 5; i++) assert.equal((await anon.post("/api/auth/password-reset", { email: `n${i}@example.com` })).status, 200);
  const sixth = await anon.post("/api/auth/password-reset", { email: "n6@example.com" });
  assert.equal(sixth.status, 429);
  assert.ok(Number(sixth.headers["retry-after"]) > 0);

  // A second API process on the same database.
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000" }, { readEnvFiles: false });
  const other = buildApp(await createContainer(config, { db: h.db, clock: h.clock, passwordCost: { N: 1024, r: 8, p: 1 }, mailer: null }));
  await other.app.ready();
  const res = await other.app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email: "x@example.com" }, headers: { "x-make-good": "1" } });
  assert.equal(res.statusCode, 429);

  h.clock.advance(15 * 60_000 + 1000);
  assert.equal((await anon.post("/api/auth/password-reset", { email: "later@example.com" })).status, 200, "a new window starts");
});

test("row-level security: inside one shop's request, the database itself hides and refuses other shops' rows", async () => {
  const h = await harness();
  const ada = await h.person("Ada", "Emberline Ceramics");
  const bo = await h.person("Bo", "Garden Ltd");
  for (const p of [ada, bo]) await p.post(`/api/orgs/${p.orgId}/incidents`, { kind: "recall", title: `Recall at ${p.email}` });
  assert.equal(await h.db.rowSecurity(), true, "the rules apply to this connection");

  // Every table holding shop data has the rules switched on and forced, including any added later.
  const unprotected = await h.db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and (not c.relrowsecurity or not c.relforcerowsecurity)
        and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'org_id')`,
  );
  assert.deepEqual(unprotected, []);

  // A query that forgets "where org_id = ..." still sees only Ada's shop.
  const seen = await h.db.withOrg(ada.orgId, () => h.db.query<{ org_id: string }>("select org_id from incidents"));
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((r) => r.org_id === ada.orgId), "Bo's incidents are invisible");
  const orgs = await h.db.withOrg(ada.orgId, () => h.db.query<{ id: string }>("select id from organisations"));
  assert.deepEqual(orgs.map((o) => o.id), [ada.orgId]);

  // Writing into another shop is refused by the database.
  await assert.rejects(
    h.db.withOrg(ada.orgId, () => h.db.query("insert into incidents (org_id, kind, title) values ($1, 'recall', 'planted')", [bo.orgId])),
    /row-level security/,
  );
  const updated = await h.db.withOrg(ada.orgId, () => h.db.query("update incidents set title = 'changed' where org_id = $1 returning id", [bo.orgId]));
  assert.equal(updated.length, 0, "and another shop's rows cannot be changed");

  // A nested transaction inside the scope is a savepoint: its failure is undone alone.
  const count = await h.db.withOrg(ada.orgId, async () => {
    await h.db.tx(async (tx) => tx.query("update incidents set title = title where org_id = $1", [ada.orgId])).catch(() => undefined);
    await h.db.tx(async () => { throw new Error("undo me"); }).catch(() => undefined);
    return (await h.db.query<{ n: number }>("select count(*)::int as n from incidents"))[0]!.n;
  });
  assert.ok(count >= 1);
  // Outside a scope (sign-in, the job worker), nothing changes.
  assert.ok((await h.db.query("select id from organisations")).length >= 2);
});

test("row-level security rules never cast an empty shop setting to a uuid", async () => {
  const h = await harness();
  await h.person("Ada", "Emberline Ceramics");
  // Real PostgreSQL may evaluate either side of an OR first, so every cast must go through nullif.
  const policies = await h.db.query<{ tablename: string; qual: string }>("select tablename, qual from pg_policies where policyname = 'org_isolation'");
  assert.ok(policies.length > 20);
  const unsafe = policies.filter((p) => /current_setting\('app\.org_id'::text, true\)\)?::uuid/.test(p.qual.replace(/nullif\([^)]*\)\)?/g, "")));
  assert.deepEqual(unsafe.map((p) => p.tablename), []);
  // A connection that once ran a shop's transaction keeps app.org_id as ''. Unscoped reads must still work.
  await h.db.query("select set_config('app.org_id', '', false)");
  assert.ok((await h.db.query("select id from organisations")).length >= 1);
  assert.equal((await h.db.query<{ v: string | null }>("select nullif(current_setting('app.org_id', true), '')::uuid as v"))[0]!.v, null);
});
