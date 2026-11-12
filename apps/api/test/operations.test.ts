// Production basics: the workspace export, error tracking and the AI switch.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/api/routes.ts";
import { createContainer } from "../src/container.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { loadConfig } from "../src/platform/config.ts";
import { testDb } from "./helpers.ts";
import type { Email, Mailer } from "../src/modules/notify/mailer.ts";

async function setup(env: Record<string, string> = {}, mailer: Mailer | null = null) {
  const posted: unknown[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://hooks.example")) posted.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const db = await testDb();
  const clock = new FakeClock("2026-11-12T09:00:00.000Z");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000", ...env }, { readEnvFiles: false });
  const container = await createContainer(config, { db, clock, passwordCost: { N: 1024, r: 8, p: 1 }, fetchImpl: fakeFetch, mailer });
  const { app } = buildApp(container);
  await app.ready();
  const client = () => {
    let cookie = "";
    return async (method: string, url: string, body?: unknown) => {
      const res = await app.inject({
        method: method as "GET", url, payload: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-make-good": "1" }), ...(cookie ? { cookie } : {}) },
      });
      const set = res.headers["set-cookie"];
      if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
      let parsed: any = null;
      try {
        parsed = res.body ? JSON.parse(res.body) : null;
      } catch {
        parsed = res.rawPayload;
      }
      return { status: res.statusCode, body: parsed, headers: res.headers };
    };
  };
  const owner = async (name: string, shop: string) => {
    const call = client();
    await call("POST", "/api/auth/register", { email: `${name}@example.com`, password: "correct horse battery", name });
    const org = (await call("POST", "/api/orgs", { name: shop })).body.id as string;
    return { call, org };
  };
  return { db, clock, container, owner, posted };
}

test("the workspace export holds this shop's records, readable, and no credentials or tokens", async () => {
  const s = await setup();
  const ada = await s.owner("ada", "Kitchen Co");
  const bo = await s.owner("bo", "Garden Ltd");
  for (const p of [ada, bo]) await p.call("POST", `/api/orgs/${p.org}/paypal/simulator`);
  const store = (await ada.call("POST", `/api/orgs/${ada.org}/stores`, { name: "Main shop" })).body.id;
  const order = { externalId: "1001", orderNumber: "1001", placedAt: "2026-10-01T10:00:00Z", currency: "USD", customer: { email: "maya@example.com", name: "Maya Chen" },
    paymentMethod: "paypal", lines: [{ externalId: "1", sku: "HM-300", title: "Hand mixer", quantity: 1, unitPrice: "59.00" }], total: "59.00" };
  const imported = await ada.call("POST", `/api/orgs/${ada.org}/stores/${store}/orders`, { orders: [order] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));

  const res = await ada.call("GET", `/api/orgs/${ada.org}/export`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-disposition"]), /attachment; filename="make-good-kitchen-co-2026-11-12\.json"/);
  const text = JSON.stringify(res.body);
  assert.equal(res.body.tables.orders[0].customer_email, "maya@example.com", "customer data comes out readable");
  assert.equal(res.body.tables.orders[0].customer_name, "Maya Chen");
  assert.ok(res.body.tables.paypal_connections.length === 1);
  assert.equal(/ciphertext|token_hash|password_hash|pii1:/.test(text), false, "no secrets and nothing left sealed");
  assert.equal(text.includes(bo.org), false, "nothing from another shop");

  const viewer = await s.owner("cy", "Cy Shop");
  assert.equal((await viewer.call("GET", `/api/orgs/${ada.org}/export`)).status, 404, "a stranger cannot export it");
  const actions = await s.db.query<{ action: string }>("select action from audit_events where org_id = $1 and action = 'organisation.exported'", [ada.org]);
  assert.equal(actions.length, 1, "the export is on the audit trail");
});

test("errors are recorded for the workspace, shown to its owner, and posted to the webhook", async () => {
  const s = await setup({ ERROR_WEBHOOK_URL: "https://hooks.example/errors" });
  const ada = await s.owner("ada", "Kitchen Co");
  await s.db.query("alter table commerce_connections rename to commerce_connections_gone");
  const broken = await ada.call("GET", `/api/orgs/${ada.org}/stores`);
  await s.db.query("alter table commerce_connections_gone rename to commerce_connections");
  assert.equal(broken.status, 500);
  assert.equal(broken.body.error.message, "Something went wrong on our side.", "the visitor sees no internals");
  await new Promise((r) => setTimeout(r, 50));

  const errors = await ada.call("GET", `/api/orgs/${ada.org}/errors`);
  assert.equal(errors.status, 200);
  assert.equal(errors.body.total, 1);
  assert.equal(errors.body.rows[0].where, "GET /api/orgs/:orgId/stores");
  assert.match(errors.body.rows[0].message, /commerce_connections/);
  assert.equal(s.posted.length, 1);
  assert.match((s.posted[0] as { text: string }).text, /GET \/api\/orgs\/:orgId\/stores/);

  const bo = await s.owner("bo", "Garden Ltd");
  assert.equal((await bo.call("GET", `/api/orgs/${bo.org}/errors`)).body.total, 0, "another shop does not see it");

  // A failed background job is recorded too.
  await s.container.errorLog({ source: "job", where: "notices.send", orgId: ada.org, error: new Error("mail server down") });
  assert.equal((await ada.call("GET", `/api/orgs/${ada.org}/errors`)).body.total, 2);
});

test("a workspace can switch the AI off", async () => {
  const s = await setup();
  const ada = await s.owner("ada", "Kitchen Co");
  const off = await ada.call("PATCH", `/api/orgs/${ada.org}/settings`, { aiEnabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.aiEnabled, false);
  const me = await ada.call("GET", "/api/me");
  assert.equal(me.body.organisations[0].settings.aiEnabled, false);
});

// A real 1x1 PNG, and a file that only pretends to be one.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FAKE = Buffer.from("<script>alert(1)</script>").toString("base64");

test("claims: a customer sends one with a photo, staff see the matching order and decide, the customer is told", async () => {
  const sent: Email[] = [];
  const mailer: Mailer = { transport: "file", send: async (e) => (sent.push(e), { ref: `mem/${e.id}` }) };
  const s = await setup({}, mailer);
  const ada = await s.owner("ada", "Kitchen Co");
  const store = (await ada.call("POST", `/api/orgs/${ada.org}/stores`, { name: "Main shop" })).body.id;
  await ada.call("POST", `/api/orgs/${ada.org}/stores/${store}/orders`, {
    orders: [{ externalId: "1001", orderNumber: "1001", placedAt: "2026-10-01T10:00:00Z", currency: "USD", customer: { email: "maya@example.com", name: "Maya Chen" },
      paymentMethod: "paypal", lines: [{ externalId: "1", sku: "HM-300", title: "Hand mixer", quantity: 1, unitPrice: "59.00" }], total: "59.00" }],
  });
  const incident = (await ada.call("POST", `/api/orgs/${ada.org}/incidents`, { kind: "recall", title: "HM-300 recall" })).body.id;

  const opened = await ada.call("POST", `/api/orgs/${ada.org}/incidents/${incident}/claims/open`, { open: true, instructions: "Send a photo of the label." });
  assert.equal(opened.status, 200);
  const slug = opened.body.slug as string;
  assert.match(opened.body.url, new RegExp(`/claim/${slug}$`));

  const anon = (await s.owner("zz", "Other")).call; // any browser; the public routes need no account
  const form = await anon("GET", `/api/public/claims/form/${slug}`);
  assert.deepEqual([form.body.shop, form.body.title, form.body.instructions], ["Kitchen Co", "HM-300 recall", "Send a photo of the label."]);
  assert.equal((await anon("POST", `/api/public/claims/form/${slug}`, { name: "Maya", email: "maya@example.com", statement: "short" })).status, 422);
  const claim = await anon("POST", `/api/public/claims/form/${slug}`, {
    name: "Maya Chen", email: "Maya@Example.com", orderNumber: "1001", batchCode: "B-2217", statement: "I bought the HM-300 mixer in October and it has batch B-2217.",
  });
  assert.equal(claim.status, 200);
  const token = claim.body.token as string;
  assert.match(sent.at(-1)!.text, new RegExp(`/claim/status/${token}`), "the customer is emailed a private status link");

  const files = `/api/public/claims/status/${token}/files`;
  assert.equal((await anon("POST", files, { kind: "product_label", name: "evil.png", data: FAKE })).status, 422, "the content decides the type, not the name");
  assert.deepEqual((await anon("POST", files, { kind: "product_label", name: "label.png", data: PNG })).body, { added: true, duplicate: false });
  assert.equal((await anon("POST", files, { kind: "product_label", data: PNG })).body.duplicate, true, "the same file is kept once");

  const list = await ada.call("GET", `/api/orgs/${ada.org}/incidents/${incident}/claims`);
  assert.equal(list.body.claims.length, 1);
  const id = list.body.claims[0].id as string;
  const detail = await ada.call("GET", `/api/orgs/${ada.org}/claims/${id}`);
  assert.deepEqual([detail.body.claimant_name, detail.body.declared.orderNumber, detail.body.files.length], ["Maya Chen", "1001", 1]);
  assert.equal(detail.body.matches[0].order_number, "1001");
  assert.equal(detail.body.matches[0].how, "order number");
  const file = await ada.call("GET", `/api/orgs/${ada.org}/claims/${id}/files/${detail.body.files[0].id}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-type"], "image/png");
  assert.equal(Buffer.from(file.body).toString("base64"), PNG, "staff get the exact file back");
  const [stored] = await s.db.query<{ sealed: boolean }>("select content like 'pii1:%' and claimant_name is not null as sealed from claim_evidence e join claims c on c.id = e.claim_id where c.id = $1", [id]);
  const [raw] = await s.db.query<{ n: boolean }>("select claimant_name like 'pii1:%' as n from claims where id = $1", [id]);
  assert.ok(stored!.sealed && raw!.n, "the photo and the name are stored encrypted");

  const bo = await s.owner("bo", "Garden Ltd");
  assert.equal((await bo.call("GET", `/api/orgs/${ada.org}/claims/${id}`)).status, 404, "another shop cannot read it");

  assert.equal((await ada.call("POST", `/api/orgs/${ada.org}/claims/${id}/decision`, { decision: "needs_evidence" })).status, 422, "a request must say why");
  await ada.call("POST", `/api/orgs/${ada.org}/claims/${id}/decision`, { decision: "needs_evidence", note: "Please add a photo of your receipt." });
  assert.match(sent.at(-1)!.text, /Please add a photo of your receipt/);
  const status = await anon("GET", `/api/public/claims/status/${token}`);
  assert.equal(status.body.status, "needs_evidence");
  assert.ok(status.body.events.some((e: { body: string }) => /receipt/.test(e.body)));
  const decided = await ada.call("POST", `/api/orgs/${ada.org}/claims/${id}/decision`, { decision: "approve" });
  assert.equal(decided.body.status, "approved");
  assert.match(sent.at(-1)!.text, /accepted/);
  assert.equal((await anon("POST", files, { kind: "receipt", data: PNG.replace("A", "B") })).status, 409, "no files after a decision");

  await ada.call("POST", `/api/orgs/${ada.org}/incidents/${incident}/claims/open`, { open: false });
  assert.equal((await anon("GET", `/api/public/claims/form/${slug}`)).status, 404, "a closed form is gone");
});
