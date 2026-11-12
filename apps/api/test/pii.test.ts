// Customer data at rest: sealing, the keyed index, the backfill of old rows,
// and search by email once the data is encrypted.

import assert from "node:assert/strict";
import { test } from "node:test";
import { listOrders } from "../src/modules/reporting/queries.ts";
import { sealExistingCustomerData } from "../src/platform/pii-backfill.ts";
import { Pii } from "../src/platform/pii.ts";
import { scenario } from "./scenario.ts";

test("sealed values open to the same text, look different every time, and refuse tampering", () => {
  const pii = Pii.ephemeral();
  const a = pii.seal("maya@example.com");
  const b = pii.seal("maya@example.com");
  assert.match(a, /^pii1:/);
  assert.notEqual(a, b, "a random IV: equal emails are not visibly equal");
  assert.equal(pii.open(a), "maya@example.com");
  assert.equal(pii.seal(null), null);
  assert.equal(pii.seal(a), a, "sealing twice changes nothing");
  const tampered = a.slice(0, -2) + (a.endsWith("A") ? "B" : "A") + a.slice(-1);
  assert.throws(() => pii.open(tampered), "a changed value fails its authentication tag");
  assert.throws(() => Pii.ephemeral().open(a), "another key cannot open it");

  assert.equal(pii.emailIndex(" Maya@Example.com "), pii.emailIndex("maya@example.com"), "the index ignores case and spaces");
  assert.notEqual(Pii.ephemeral().emailIndex("maya@example.com"), pii.emailIndex("maya@example.com"), "the index needs the key");
  assert.deepEqual(pii.openRows([{ x: a, n: 1 }]), [{ x: "maya@example.com", n: 1 }]);
});

test("customer data stored before encryption is sealed at start-up, and search by email still works", async () => {
  const s = await scenario();
  await s.sell({ email: "old.customer@example.com" });
  // Pretend the row was written by an older version: plain text everywhere.
  await s.db.query(
    `update orders set customer_email = 'Old.Customer@example.com', customer_email_normalized = 'old.customer@example.com',
            customer_name = 'Old Customer', raw = '{"note":"from the store"}'::jsonb where org_id = $1`,
    [s.orgId],
  );
  const changed = await sealExistingCustomerData(s.db);
  assert.ok(changed >= 1);
  const [raw] = await s.db.query<{ email: string; idx: string; name: string; raw: string }>(
    "select customer_email || '' as email, customer_email_normalized as idx, customer_name || '' as name, raw::text as raw from orders where org_id = $1",
    [s.orgId],
  );
  // The values above came back opened by the database layer. What is actually stored:
  const [stored] = await s.db.query<{ sealed: boolean; indexed: boolean; rawSealed: boolean }>(
    `select customer_email like 'pii1:%' as sealed, customer_email_normalized like 'h1:%' as indexed, jsonb_typeof(raw) = 'string' as "rawSealed"
       from orders where org_id = $1`,
    [s.orgId],
  );
  assert.deepEqual(stored, { sealed: true, indexed: true, rawSealed: true });
  assert.equal(raw!.email, "Old.Customer@example.com", "and it reads back as before");
  assert.equal(raw!.name, "Old Customer");
  assert.equal(raw!.idx, s.db.pii.emailIndex("old.customer@example.com"));
  assert.equal(await sealExistingCustomerData(s.db), 0, "a second run has nothing to do");

  const found = await listOrders(s.db, s.orgId, { search: "OLD.customer@example.com" }, { limit: 10, offset: 0 });
  assert.equal(found.total, 1, "a whole email address finds the order");
  assert.equal((await listOrders(s.db, s.orgId, { search: "old.cust" }, { limit: 10, offset: 0 })).total, 0, "part of an email cannot be searched once encrypted");
});
