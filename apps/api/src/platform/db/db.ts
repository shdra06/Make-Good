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
import { AsyncLocalStorage } from "node:async_hooks";
import { Pii } from "../pii.ts";

export type Row = Record<string, unknown>;

export interface Queryable {
  /** Rows come back with customer data already opened (see pii.ts). */
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Seals customer data before it is written. */
  readonly pii: Pii;
  /** Runs several statements with no parameters. Used by migrations. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: "postgres" | "pglite";
  /** Runs `fn` in one transaction. Commits when it resolves, rolls back when it throws. */
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` as work for one organisation: in one transaction where row-level
   * security shows only that organisation's rows (migration 0007). Every query
   * made through this Db inside `fn`, however deep, joins that transaction;
   * a nested tx() becomes a savepoint. Commits when `fn` resolves.
   */
  withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
  /** Whether row-level security actually applies to this connection (false for a superuser with no makegood_app role). */
  rowSecurity(): Promise<boolean>;
  close(): Promise<void>;
}

type Scope = { tx: Queryable; savepoints: number; open: boolean };
const scopes = new AsyncLocalStorage<Scope>();

/** Adds withOrg() to a driver's Db. Queries inside a scope go to the scope's transaction. */
function scopeable(base: Omit<Db, "withOrg" | "rowSecurity">): Db {
  const current = () => {
    const s = scopes.getStore();
    return s && s.open ? s : null;
  };
  let canSwitchRole: Promise<{ role: boolean; enforced: boolean }> | null = null;
  const roleInfo = () =>
    (canSwitchRole ??= base
      .query<{ bypass: boolean; member: boolean }>(
        `select (r.rolsuper or r.rolbypassrls) as bypass,
                exists (select 1 from pg_roles a where a.rolname = 'makegood_app') and pg_has_role(current_user, 'makegood_app', 'member') as member
           from pg_roles r where r.rolname = current_user`,
      )
      .then(([r]) => ({ role: Boolean(r?.member && r.bypass), enforced: Boolean(r && (!r.bypass || r.member)) })));

  const db: Db = {
    kind: base.kind,
    pii: base.pii,
    query: (sql, params) => (current()?.tx ?? base).query(sql, params),
    exec: (sql) => (current()?.tx ?? base).exec(sql),
    async tx(fn) {
      const s = current();
      if (!s) return base.tx(fn);
      const name = `sp_${++s.savepoints}`;
      await s.tx.query(`savepoint ${name}`);
      try {
        const out = await fn(s.tx);
        await s.tx.query(`release savepoint ${name}`);
        return out;
      } catch (err) {
        await s.tx.query(`rollback to savepoint ${name}`).catch(() => undefined);
        throw err;
      }
    },
    async withOrg(orgId, fn) {
      if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("withOrg needs an organisation id.");
      const outer = current();
      if (outer) return fn(); // already scoped (same request)
      const { role } = await roleInfo();
      return base.tx(async (tx) => {
        if (role) await tx.query("set local role makegood_app");
        await tx.query("select set_config('app.org_id', $1, true)", [orgId]);
        const scope: Scope = { tx, savepoints: 0, open: true };
        try {
          return await scopes.run(scope, fn);
        } finally {
          // Work started inside the scope that outlives it uses the database directly.
          scope.open = false;
        }
      });
    },
    async rowSecurity() {
      return (await roleInfo()).enforced;
    },
    close: () => base.close(),
  };
  return db;
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

/**
 * `pii` holds the key for customer data. Without one, a random key is used: right
 * for in-memory databases, wrong for anything kept (its data could not be read again).
 */
export async function openDb(options: OpenOptions, pii?: Pii): Promise<Db> {
  if (!pii && !("pglite" in options && options.pglite === "memory")) throw new Error("A kept database needs the customer-data key.");
  const key = pii ?? Pii.ephemeral();
  return "url" in options ? openPostgres(options.url, key) : openPglite(options, key);
}

async function openPostgres(url: string, pii: Pii): Promise<Db> {
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
    pii,
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await runner.query(sql, params as unknown[]);
      return pii.openRows(res.rows as T[]);
    },
    async exec(sql: string) {
      await runner.query(sql);
    },
  });

  return scopeable({
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
  });
}

async function openPglite(options: { pglite: "memory" } | { pglite: "file"; dataDir: string }, pii: Pii): Promise<Db> {
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
    pii,
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await runner.query(sql, params as unknown[]);
      return pii.openRows(res.rows as T[]);
    },
    async exec(sql: string) {
      await runner.exec(sql);
    },
  });

  return scopeable({
    kind: "pglite",
    ...wrap(db as unknown as Runner),
    async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await db.transaction(async (t) => fn(wrap(t as unknown as Runner)))) as T;
    },
    async close() {
      await db.close();
    },
  });
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
