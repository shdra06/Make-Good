// The recall time line: batch stock windows, mixed stock, ship dates and
// PayPal's 180-day refund window, on the synthetic recall case.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/api/routes.ts";
import { createContainer } from "../src/container.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { loadConfig } from "../src/platform/config.ts";
import { mixedStockWindows, refundDeadline, type TimelineBatch } from "../src/modules/recovery/timeline.ts";
import { testDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = "2026-11-11T09:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(START) - n * DAY).toISOString();

test("refund deadline: open, closing soon, closed, and no PayPal payment", () => {
  const now = new Date(START);
  const paid = (days: number) => new Date(now.getTime() - days * DAY);
  assert.deepEqual(refundDeadline(paid(10), now), { refundDeadline: new Date(paid(10).getTime() + 180 * DAY).toISOString(), daysLeft: 170, deadline: "open" });
  assert.equal(refundDeadline(paid(150), now).deadline, "closing_soon", "30 days left is closing soon");
  assert.equal(refundDeadline(paid(149), now).deadline, "open", "31 days left is still open");
  assert.equal(refundDeadline(paid(180), now).deadline, "closed", "on day 180 the window has closed");
  assert.deepEqual(refundDeadline(null, now), { refundDeadline: null, daysLeft: null, deadline: "no_paypal_payment" });
});

test("mixed stock: only where an affected batch and another batch of the same product leave the same warehouse", () => {
  const b = (code: string, first: number, last: number, extra: Partial<TimelineBatch> = {}): TimelineBatch => ({
    id: code, sku: "CM-412", batchCode: code, warehouse: "default", quantity: null, receivedAt: null,
    firstShippedAt: daysAgo(first), lastShippedAt: daysAgo(last), affected: code === "K-0719", ...extra,
  });
  assert.deepEqual(mixedStockWindows([b("K-0711", 60, 41), b("K-0719", 40, 22), b("K-0726", 27, 2)]), [
    { sku: "CM-412", warehouse: "default", from: daysAgo(27), to: daysAgo(22), affectedBatch: "K-0719", otherBatch: "K-0726" },
  ]);
  assert.deepEqual(mixedStockWindows([b("K-0719", 40, 22), b("K-0726", 27, 2, { warehouse: "north" })]), [], "another warehouse is not mixed stock");
  assert.deepEqual(mixedStockWindows([b("K-0719", 40, 22), b("K-0726", 27, 2, { sku: "CM-999" })]), [], "another product is not mixed stock");
  assert.deepEqual(mixedStockWindows([b("K-0719", 40, 30), b("K-0726", 27, 2)]), [], "no overlap, no mixed stock");
});

test("the recall time line on the synthetic case, read only", async () => {
  const db = await testDb();
  const clock = new FakeClock(START);
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000" }, { readEnvFiles: false });
  const container = await createContainer(config, { db, clock, passwordCost: { N: 1024, r: 8, p: 1 }, ai: null });
  const { app } = buildApp(container);
  await app.ready();
  let cookie = "";
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await app.inject({
      method, url, payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-make-good": "1" }), ...(cookie ? { cookie } : {}) },
    });
    const set = res.headers["set-cookie"];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body);
  };

  await call("POST", "/api/auth/register", { email: "ada@example.com", password: "correct horse battery", name: "Ada" });
  const org: string = (await call("POST", "/api/orgs", { name: "Emberline Ceramics" })).id;
  await call("POST", `/api/orgs/${org}/paypal/simulator`);
  const seeded = await call("POST", `/api/orgs/${org}/demo/recall-scenario`);
  const inc = `/api/orgs/${org}/incidents/${seeded.incidentId}`;

  const before = await call("GET", `${inc}/timeline`);
  assert.equal(before.scope, null, "no rules yet, so nothing to draw");
  assert.deepEqual(before.records, []);

  await call("POST", `${inc}/rules`, { scope: { type: "product", skus: ["CM-412", "CM-412-GB"], batchCodes: ["K-0719"] }, compensation: { type: "full_refund" } });
  await call("POST", `${inc}/match`);
  const counts = async () => (await db.query<{ n: number }>("select (select count(*) from candidates) + (select count(*) from payment_operations) + (select count(*) from audit_events) as n"))[0]!.n;
  const writesBefore = await counts();

  const t = await call("GET", `${inc}/timeline`);
  assert.equal(await counts(), writesBefore, "reading the time line writes nothing, not even an audit row");
  assert.equal(t.labels.merchantRecords, "synthetic", "the sample data is labelled as invented");
  assert.equal(t.refundWindowDays, 180);
  assert.deepEqual(t.batches.map((b: any) => [b.batchCode, b.affected, b.firstShippedAt, b.lastShippedAt]), [
    ["K-0711", false, daysAgo(60), daysAgo(41)],
    ["K-0719", true, daysAgo(40), daysAgo(22)],
    ["K-0726", false, daysAgo(27), daysAgo(2)],
  ]);
  assert.deepEqual(t.mixedStock, [{ sku: "CM-412", warehouse: "default", from: daysAgo(27), to: daysAgo(22), affectedBatch: "K-0719", otherBatch: "K-0726" }]);

  const [{ n: candidates }] = await db.query<{ n: number }>("select count(*)::int as n from candidates where incident_id = $1", [seeded.incidentId]);
  assert.equal(t.records.length, candidates, "every record of the incident is on the line");
  for (const r of t.records) {
    if (r.shippedAt && r.eligibility === "uncertain") {
      // An uncertain record that shipped without a batch code shipped while stock was mixed, or outside the known windows.
      assert.ok(r.recordedBatches.length === 0 || r.recordedBatches.length > 1, `${r.orderNumber}: uncertain despite one recorded batch`);
    }
    if (r.paidAt) assert.equal(Date.parse(r.refundDeadline) - Date.parse(r.paidAt), 180 * DAY);
    else assert.equal(r.deadline, "no_paypal_payment");
  }
  assert.ok(t.records.some((r: any) => r.recordedBatches.includes("K-0719")), "a batch code written at packing is shown");
  assert.equal(t.summary.closed, 0, "the sample payments are all recent");
  assert.ok(t.summary.windowOpen > 0);

  // 170 days later, the oldest sample payments are inside the last 30 days of their window, or past it.
  clock.advance(170 * DAY);
  cookie = "";
  await call("POST", "/api/auth/login", { email: "ada@example.com", password: "correct horse battery" }); // the old session has expired
  const later = await call("GET", `${inc}/timeline`);
  assert.ok(later.summary.closingSoon + later.summary.closed > 0, "the deadline moves with the clock");
  assert.equal(later.summary.windowOpen, 0, "nothing paid at least 10 days before the start has more than 30 days left");
  assert.ok(later.summary.owedAfterWindowClosed + later.summary.owedClosingSoon > 0, "records still owed are flagged against the deadline");
});
