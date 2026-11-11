import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate } from "../src/platform/db/migrate.ts";
import { testDb } from "./helpers.ts";

test("migrations apply to an empty database and are not applied twice", async () => {
  const db = await testDb();
  const again = await migrate(db);
  assert.deepEqual(again.applied, []);
  assert.ok(again.alreadyApplied.includes("0001_init.sql"));
  const tables = await db.query<{ n: number }>(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  assert.ok((tables[0]?.n ?? 0) >= 38, `expected the full schema, found ${tables[0]?.n} tables`);
  await db.close();
});

test("the database refuses cross-organisation references", async () => {
  const db = await testDb();
  const [a] = await db.query<{ id: string }>("insert into organisations (name, slug) values ('A', 'org-a') returning id");
  const [b] = await db.query<{ id: string }>("insert into organisations (name, slug) values ('B', 'org-b') returning id");
  const [conn] = await db.query<{ id: string }>(
    "insert into commerce_connections (org_id, kind, name) values ($1, 'csv', 'Store A') returning id",
    [a!.id],
  );
  // Organisation B tries to file an order under a connection that belongs to organisation A.
  await assert.rejects(
    db.query(
      `insert into orders (org_id, connection_id, external_id, order_number, placed_at, currency, subtotal_minor, total_minor)
       values ($1, $2, 'x1', '1001', now(), 'USD', 100, 100)`,
      [b!.id, conn!.id],
    ),
    /foreign key/i,
  );
  await db.close();
});

test("money columns refuse negative and inconsistent amounts", async () => {
  const db = await testDb();
  const [org] = await db.query<{ id: string }>("insert into organisations (name, slug) values ('A', 'org-a') returning id");
  await assert.rejects(
    db.query(
      `insert into payment_transactions (org_id, environment, transaction_id, kind, occurred_at, currency, gross_minor, refunded_minor, source)
       values ($1, 'sandbox', 'T1', 'payment', now(), 'USD', 1000, 1500, 'file_import')`,
      [org!.id],
    ),
    /check constraint/i,
    "refunded more than the payment",
  );
  await assert.rejects(
    db.query(
      `insert into payment_transactions (org_id, environment, transaction_id, kind, occurred_at, currency, gross_minor, source)
       values ($1, 'sandbox', 'T2', 'payment', now(), 'usd', 1000, 'file_import')`,
      [org!.id],
    ),
    /check constraint/i,
    "currency must be upper case",
  );
  await db.close();
});

test("the audit log cannot be edited or deleted", async () => {
  const db = await testDb();
  await db.query("insert into audit_events (actor_kind, action, entity_type, hash) values ('system', 'test', 'none', 'h1')");
  await assert.rejects(db.query("update audit_events set action = 'changed'"), /append-only/);
  await assert.rejects(db.query("delete from audit_events"), /append-only/);
  await db.close();
});
