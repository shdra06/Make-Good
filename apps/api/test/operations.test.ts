// Production basics: the workspace export, error tracking and the AI switch.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/api/routes.ts";
import { createContainer } from "../src/container.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { loadConfig } from "../src/platform/config.ts";
import { testDb } from "./helpers.ts";

async function setup(env: Record<string, string> = {}) {
  const posted: unknown[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://hooks.example")) posted.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const db = await testDb();
  const clock = new FakeClock("2026-11-12T09:00:00.000Z");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000", ...env }, { readEnvFiles: false });
  const container = await createContainer(config, { db, clock, passwordCost: { N: 1024, r: 8, p: 1 }, fetchImpl: fakeFetch, mailer: null });
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
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
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
