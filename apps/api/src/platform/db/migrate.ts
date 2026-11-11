// Applies SQL migration files in order, each in its own transaction, and
// records what was applied. A file that changed after it was applied is an
// error: history is never rewritten, a new migration is added instead.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`);

  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const done = new Map(
    (await db.query<{ version: string; checksum: string }>("select version, checksum from schema_migrations")).map(
      (r) => [r.version, r.checksum],
    ),
  );

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
    const previous = done.get(file);
    if (previous) {
      if (previous !== checksum) {
        throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
      }
      result.alreadyApplied.push(file);
      continue;
    }
    await db.tx(async (tx) => {
      // Two instances starting together must not both run the same file.
      await tx.query("select pg_advisory_xact_lock(727101)");
      const again = await tx.query("select 1 from schema_migrations where version = $1", [file]);
      if (again.length > 0) return;
      await tx.exec(sql);
      await tx.query("insert into schema_migrations (version, checksum) values ($1, $2)", [file, checksum]);
    });
    result.applied.push(file);
  }
  return result;
}
