// Shared test setup: a fresh in-memory PostgreSQL (PGlite) with all migrations applied.
import { openDb, type Db } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";

export async function testDb(): Promise<Db> {
  const db = await openDb({ pglite: "memory" });
  await migrate(db);
  return db;
}
