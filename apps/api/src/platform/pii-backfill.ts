// Encrypts customer data written before encryption existed. Runs at start-up,
// after migrations; does nothing once every row is sealed. Safe to run twice
// and safe to stop half-way: each row is sealed on its own.

import type { Db } from "./db/db.ts";
import { isIndexed, isSealed } from "./pii.ts";

/** Every place customer data is kept: plain columns to seal, email columns to replace with their keyed hash, JSON payloads to seal whole. */
export const CUSTOMER_DATA = [
  { table: "orders", seal: ["customer_email", "customer_name", "billing_email", "shipping_name"], index: ["customer_email_normalized"], json: ["raw"] },
  { table: "payment_transactions", seal: ["payer_email", "payer_name"], index: ["payer_email_normalized"], json: ["raw"] },
  { table: "candidates", seal: ["customer_email", "customer_name"], index: [], json: [] },
  { table: "customer_notices", seal: ["to_email", "body"], index: [], json: [] },
  { table: "provider_events", seal: [], index: [], json: ["payload"] },
] as const;

export async function sealExistingCustomerData(db: Db, batch = 500): Promise<number> {
  let sealed = 0;
  for (const spec of CUSTOMER_DATA) {
    const cols = [...spec.seal, ...spec.index, ...spec.json];
    const pending = [
      ...spec.seal.map((c) => `(${c} is not null and ${c} <> '' and ${c} not like 'pii1:%')`),
      ...spec.index.map((c) => `(${c} is not null and ${c} not like 'h1:%')`),
      ...spec.json.map((c) => `(${c} is not null and jsonb_typeof(${c}) <> 'string')`),
    ].join(" or ");
    for (;;) {
      // Raw values: read without opening, so a sealed column is recognised as sealed.
      const rows = await db.query<Record<string, unknown> & { id: string }>(
        `select id, ${cols.map((c) => (spec.json.includes(c as never) ? `${c}::text as ${c}` : c)).join(", ")} from ${spec.table} where ${pending} limit ${batch}`,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const sets: string[] = [];
        const params: unknown[] = [row.id];
        for (const c of spec.seal) {
          const v = row[c] as string | null;
          if (v && !isSealed(v)) sets.push(`${c} = $${params.push(db.pii.seal(v))}`);
        }
        for (const c of spec.index) {
          const v = row[c] as string | null;
          if (v && !isIndexed(v)) sets.push(`${c} = $${params.push(db.pii.index(v))}`);
        }
        for (const c of spec.json) {
          const v = row[c] as string | null;
          if (v !== null && !v.startsWith('"')) sets.push(`${c} = $${params.push(db.pii.sealJson(JSON.parse(v)))}::jsonb`);
        }
        if (sets.length > 0) {
          await db.query(`update ${spec.table} set ${sets.join(", ")} where id = $1`, params);
          sealed++;
        }
      }
    }
  }
  return sealed;
}
