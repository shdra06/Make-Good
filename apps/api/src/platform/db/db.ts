// Database access. PostgreSQL is the only stateful dependency of Make Good:
// it holds the records, the job queue and the audit trail.
//
//   DATABASE_URL set      -> a PostgreSQL server (production, CI)
//   DATABASE_URL not set  -> PGlite: PostgreSQL compiled to run inside this
//                            process. Used for local work and for tests, so a
//                            developer needs nothing installed.
//
// Both run the same SQL and the same migrations.
//
// PGlite has one connection, so it cannot show how two separate connections
// interleave. Locking behaviour that depends on that (SKIP LOCKED between
// workers) must be confirmed on a real server; see docs/VERIFICATION.md.

import fs from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs several statements with no parameters. Used by migrations. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: "postgres" | "pglite";
  /** Runs `fn` in one transaction. Commits when it resolves, rolls back when it throws. */
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const INT8_OID = 20;
const toSafeNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Database returned an integer too large to handle safely: ${value}`);
  return n;
};

export type OpenOptions =
  | { url: string }
  | { pglite: "memory" }
  | { pglite: "file"; dataDir: string };

export async function openDb(options: OpenOptions): Promise<Db> {
  return "url" in options ? openPostgres(options.url) : openPglite(options);
}

async function openPostgres(url: string): Promise<Db> {
  const pg = await import("pg");
  const needsSsl = /sslmode=require/.test(url) || /render\.com|neon\.tech|supabase\.co/.test(url);
  const pool = new pg.default.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    types: {
      getTypeParser: (oid: number, format?: "text" | "binary") =>
        oid === INT8_OID ? toSafeNumber : pg.default.types.getTypeParser(oid, format as "text"),
    },
  } as ConstructorParameters<typeof pg.default.Pool>[0]);

  const wrap = (runner: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryable => ({
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await runner.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await runner.query(sql);
    },
  });

  return {
    kind: "postgres",
    ...wrap(pool),
    async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(options: { pglite: "memory" } | { pglite: "file"; dataDir: string }): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  let dir: string | undefined;
  if (options.pglite === "file") {
    dir = path.resolve(options.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    claimDataDir(dir);
  }
  const db = new PGlite(dir, { parsers: { [INT8_OID]: toSafeNumber } });
  await db.waitReady;

  type Runner = {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    exec: (sql: string) => Promise<unknown>;
  };
  const wrap = (runner: Runner): Queryable => ({
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await runner.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await runner.exec(sql);
    },
  });

  return {
    kind: "pglite",
    ...wrap(db as unknown as Runner),
    async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await db.transaction(async (t) => fn(wrap(t as unknown as Runner)))) as T;
    },
    async close() {
      await db.close();
    },
  };
}

/** One process at a time may open a PGlite folder. A second one would damage it. */
function claimDataDir(dir: string): void {
  const lockFile = `${dir}.lock`;
  try {
    const pid = Number(fs.readFileSync(lockFile, "utf8"));
    if (pid && pid !== process.pid) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        throw new Error(
          `The local database in ${dir} is in use by process ${pid}. Stop it first. ` +
            `If nothing is running, delete ${lockFile}.`,
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.writeFileSync(lockFile, String(process.pid));
  process.once("exit", () => {
    try {
      if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile);
    } catch {
      // nothing to clean up
    }
  });
}

/** Builds "$1, $2, $3" for an IN list, starting after `offset` existing parameters. */
export function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${offset + i + 1}`).join(", ");
}

/** JSON values are always sent as text and cast, so both drivers treat them the same way. */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function iso(date: Date | string | number): string {
  return new Date(date).toISOString();
}
