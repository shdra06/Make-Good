// A complete small merchant for integration tests: an organisation, two staff,
// a simulated PayPal account, a store with paid orders, and helpers to take an
// incident from rules to a running batch.

import { sendAlert } from "../src/modules/notify/alerts.ts";
import { FakeClock } from "../src/platform/clock.ts";
import type { Db } from "../src/platform/db/db.ts";
import { JobRunner } from "../src/platform/jobs/queue.ts";
import { upsertBatch, upsertOrder, OrderImport, type BatchImport } from "../src/modules/commerce/ingest.ts";
import { createBatch, decideBatch, startBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { OperationExecutor } from "../src/modules/execution/executor.ts";
import { addRuleVersion, createIncident, runIncidentMatch, type MatchRunResult } from "../src/modules/incidents/service.ts";
import { SimulatedPayPal } from "../src/modules/paypal/simulator.ts";
import { syncTransactions } from "../src/modules/transactions/sync.ts";
import { fromMinor } from "../src/platform/money.ts";
import { testDb } from "./helpers.ts";

export const START = "2026-10-01T09:00:00.000Z";

export type Scenario = Awaited<ReturnType<typeof scenario>>;

export async function scenario(options: { dualControl?: boolean } = {}) {
  const db: Db = await testDb();
  const clock = new FakeClock(START);
  const paypal = new SimulatedPayPal({ now: () => clock.now() });

  const [org] = await db.query<{ id: string }>(
    "insert into organisations (name, slug, settings) values ('Emberline Ceramics', 'emberline-ceramics', $1::jsonb) returning id",
    [JSON.stringify({ approval: { dualControl: options.dualControl ?? false } })],
  );
  const orgId = org!.id;
  const user = async (email: string, role: string) => {
    const [u] = await db.query<{ id: string }>(
      "insert into users (email, email_normalized, name, password_hash) values ($1, $1, $2, 'x') returning id",
      [email, email.split("@")[0]],
    );
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, u!.id, role]);
    return u!.id;
  };
  const operator = await user("olive@emberline.test", "operator");
  const approver = await user("ada@emberline.test", "finance_approver");
  const [conn] = await db.query<{ id: string }>(
    "insert into paypal_connections (org_id, environment, mode, status) values ($1, 'simulator', 'simulator', 'connected') returning id",
    [orgId],
  );
  const [store] = await db.query<{ id: string }>(
    "insert into commerce_connections (org_id, kind, name) values ($1, 'custom', 'Test store') returning id",
    [orgId],
  );
  const deps = { db, clock };
  const executor = new OperationExecutor({ db, clock, providers: async () => paypal });
  // The same job types the server runs. Alerts go nowhere here: no mailer.
  const runner = new JobRunner(
    db,
    { ...executor.handlers(), "staff.alert": (job) => sendAlert({ db, clock, mailer: null, publicUrl: "http://localhost:3000" }, job) },
    { workerId: "test-worker", clock, concurrency: 4 },
  );
  let orderSeq = 1000;

  /**
   * A customer buys through the store and pays with (simulated) PayPal. The
   * store records the PayPal capture ID on the order, which is what makes the
   * link between the two systems exact.
   */
  async function sell(input: {
    sku?: string; quantity?: number; unitMinor?: number; email?: string; placedAt?: string; batchCode?: string | null;
    shippedAt?: string | null; currency?: string; payWithPayPal?: boolean; extra?: Partial<OrderImport>;
  } = {}) {
    const n = ++orderSeq;
    const currency = input.currency ?? "USD";
    const quantity = input.quantity ?? 1;
    const unitMinor = input.unitMinor ?? 5900;
    const total = unitMinor * quantity;
    const placedAt = input.placedAt ?? "2026-09-08T10:00:00.000Z";
    const email = input.email ?? `customer${n}@example.com`;
    const sku = input.sku ?? "CM-412";
    const capture = input.payWithPayPal === false ? null : paypal.addCapture({
      amountMinor: total, currency, createdAt: new Date(placedAt), payerEmail: email, payerName: `Customer ${n}`,
      payerId: `SIMPAYER${n}`, payerCountry: "US", invoiceId: `#${n}`,
      items: [{ code: sku, name: "Mug set", quantity, unitMinor }],
    });
    const order = OrderImport.parse({
      externalId: `ext-${n}`, orderNumber: `#${n}`, placedAt, currency,
      customer: { email, name: `Customer ${n}` },
      paymentMethod: capture ? "paypal" : "card", paymentReference: capture?.id ?? null,
      total: fromMinor(total, currency),
      lines: [{ externalId: "l1", sku, title: "Mug set CM-412", quantity, unitPrice: fromMinor(unitMinor, currency) }],
      fulfilments: input.shippedAt === null ? [] : [{
        externalId: "f1", shippedAt: input.shippedAt ?? "2026-09-10T10:00:00.000Z",
        lines: [{ lineExternalId: "l1", quantity, batchCode: input.batchCode === undefined ? "LOT-24B" : input.batchCode }],
      }],
      ...input.extra,
    });
    const { orderId } = await db.tx((tx) => upsertOrder(tx, orgId, store!.id, order));
    return { orderId, captureId: capture?.id ?? null, orderNumber: `#${n}`, email };
  }

  const stock = (batch: Partial<BatchImport> & { batchCode: string }) =>
    db.tx((tx) => upsertBatch(tx, orgId, { sku: "CM-412", warehouse: "default", quantity: null, receivedAt: null, firstShippedAt: null, lastShippedAt: null, ...batch }));

  /** Copies PayPal's transactions into our tables and links them to orders. */
  const sync = () =>
    syncTransactions(deps, { orgId, connectionId: conn!.id, provider: paypal, from: new Date("2026-03-01T00:00:00Z"), to: clock.now() });

  async function incident(input: { scope?: Record<string, unknown>; compensation?: Record<string, unknown>; kind?: string } = {}) {
    const { id } = await createIncident(deps, { orgId, userId: operator, kind: (input.kind ?? "recall") as "recall", title: "CM-412 batch LOT-24B fails a lead test", description: "" });
    await addRuleVersion(deps, {
      orgId, incidentId: id, userId: operator,
      scope: (input.scope ?? { type: "product", skus: ["CM-412"], batchCodes: ["LOT-24B"] }) as never,
      compensation: (input.compensation ?? { type: "full_refund" }) as never,
    });
    return id;
  }

  const match = (incidentId: string): Promise<MatchRunResult> =>
    runIncidentMatch(deps, { orgId, incidentId, userId: operator, payoutsAvailable: true });

  /** Creates, submits, approves and starts a batch. Jobs are queued, not yet run. */
  async function approvedBatch(incidentId: string, start = true, kind: "refund" | "payout" = "refund") {
    const { id, preview } = await createBatch(deps, { orgId, incidentId, userId: operator, name: "Batch 1", kind });
    await submitBatch(deps, { orgId, batchId: id, userId: operator });
    await decideBatch(deps, { orgId, batchId: id, userId: approver, role: "finance_approver", decision: "approve" });
    if (start) await startBatch(deps, { orgId, batchId: id, userId: operator, spacingMs: 0 });
    return { batchId: id, preview };
  }

  type OpView = {
    id: string; state: string; kind: string; capture_id: string | null; amount_minor: number; attempts: number;
    provider_refund_id: string | null; provider_payout_item_id: string | null; failure_code: string | null; idempotency_key: string;
  };
  const operations = (batchId: string) =>
    db.query<OpView>(
      `select id, state, kind, capture_id, amount_minor, attempts, provider_refund_id, provider_payout_item_id, failure_code, idempotency_key
         from payment_operations where batch_id = $1 order by created_at, id`,
      [batchId],
    );
  const batchStatus = async (batchId: string) =>
    (await db.query<{ status: string; paused_reason: string | null }>("select status, paused_reason from batches where id = $1", [batchId]))[0]!;

  /** Runs everything due now, then moves time forward and repeats, until nothing is left within `horizonMs`. */
  async function settle(horizonMs = 2 * 60 * 60_000) {
    let waited = 0;
    for (;;) {
      await runner.drain();
      const [next] = await db.query<{ run_at: Date }>("select run_at from jobs where status = 'queued' order by run_at limit 1");
      if (!next) return;
      const gap = new Date(next.run_at).getTime() - clock.now().getTime();
      if (waited + gap > horizonMs) return;
      clock.advance(Math.max(gap, 0) + 1);
      waited += Math.max(gap, 0) + 1;
    }
  }

  return {
    db, clock, paypal, orgId, operator, approver, connectionId: conn!.id, storeId: store!.id, deps, executor, runner,
    sell, stock, sync, incident, match, approvedBatch, operations, batchStatus, settle,
  };
}
