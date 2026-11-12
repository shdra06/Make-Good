// A full copy of one workspace's data, as JSON: every table that holds rows for
// the organisation, read through the normal database layer (so customer data
// comes out readable, and row-level security keeps it to this organisation).
//
// Left out on purpose: credentials, token hashes and password hashes. A backup
// a person downloads must not hand over the keys to PayPal or to accounts.

import type { Queryable } from "./db/db.ts";

const SECRET_COLUMNS = new Set([
  "credentials_ciphertext", "webhook_secret_ciphertext", "client_secret_ciphertext", "secret_ciphertext",
  "token_hash", "access_token_hash", "password_hash",
]);
const SKIP_TABLES = new Set(["jobs", "rate_limits", "error_events"]);

export async function exportWorkspace(q: Queryable, orgId: string, now: Date) {
  const columns = await q.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and c.table_name in (select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id')
      order by c.table_name, c.ordinal_position`,
  );
  const byTable = new Map<string, string[]>();
  for (const c of columns) {
    if (SKIP_TABLES.has(c.table_name) || SECRET_COLUMNS.has(c.column_name) || c.column_name.endsWith("_ciphertext")) continue;
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  }
  const tables: Record<string, unknown[]> = {};
  const [org] = await q.query("select id, name, slug, default_currency, settings, created_at from organisations where id = $1", [orgId]);
  for (const [table, cols] of [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const list = cols.map((c) => `"${c}"`).join(", ");
    tables[table] = await q.query(`select ${list} from "${table}" where org_id = $1`, [orgId]);
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]));
  return {
    format: "makegood.workspace-export/1",
    exportedAt: now.toISOString(),
    organisation: org ?? null,
    note: "Credentials, password hashes and link tokens are not included. Amounts are integer minor units.",
    counts,
    tables,
  };
}
