// SQLite through Node's built-in driver. Unique keys here are a safety net against double
// payments: one payment item per affected customer per incident, one request ID per item.
//
// In MOCK mode the database is in memory, because the mock PayPal is in memory too; the demo
// seeds itself on every start. In SANDBOX mode it is a file, because PayPal keeps the payments.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, paypalMode } from "./config.ts";

const file = paypalMode === "mock" ? ":memory:" : config.dbPath;
if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS paypal_txn (
  txn_id TEXT PRIMARY KEY,            -- PayPal transaction ID (= capture ID for checkout payments)
  payer_email TEXT, payer_name TEXT,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  invoice_id TEXT,
  items_json TEXT NOT NULL DEFAULT '[]',
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  disputed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'search'  -- 'search' (Transaction Search) or 'seed-record'
);
CREATE INDEX IF NOT EXISTS txn_invoice ON paypal_txn(invoice_id);
CREATE INDEX IF NOT EXISTS txn_email ON paypal_txn(payer_email);

CREATE TABLE IF NOT EXISTS order_line (
  id INTEGER PRIMARY KEY,
  order_number TEXT NOT NULL, email TEXT, customer_name TEXT,
  paid_at TEXT NOT NULL,
  sku TEXT NOT NULL, item_name TEXT, qty INTEGER NOT NULL,
  unit_cents INTEGER NOT NULL, line_discount_cents INTEGER NOT NULL DEFAULT 0,
  order_total_cents INTEGER NOT NULL,
  shipped_at TEXT, batch_code TEXT,
  paid_via TEXT NOT NULL DEFAULT 'paypal',
  UNIQUE(order_number, sku)
);
CREATE INDEX IF NOT EXISTS order_sku ON order_line(sku);

CREATE TABLE IF NOT EXISTS incident (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'product',
  title TEXT NOT NULL, description TEXT NOT NULL,
  rules_json TEXT NOT NULL, rules_source TEXT NOT NULL DEFAULT 'person',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | confirmed | matched
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS affected (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incident(id),
  ref_key TEXT NOT NULL,                  -- order number, or the PayPal transaction ID when no order exists
  txn_id TEXT, order_number TEXT, email TEXT, customer_name TEXT,
  paid_at TEXT, level INTEGER NOT NULL,   -- precision level 1 to 5
  match_kind TEXT NOT NULL,               -- invoice | fallback | paypal-only | outside | claim
  owed_cents INTEGER NOT NULL, why TEXT NOT NULL,
  state TEXT NOT NULL,                    -- ready | needs_confirm | confirmed | declined | excluded | queued | paid | failed
  excluded_reason TEXT,
  confirm_token TEXT UNIQUE, status_token TEXT UNIQUE,
  UNIQUE(incident_id, ref_key)
);

CREATE TABLE IF NOT EXISTS batch (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incident(id),
  label TEXT NOT NULL, total_cents INTEGER NOT NULL, item_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',    -- draft | approved | running | paused | done
  approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_item (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batch(id), incident_id TEXT NOT NULL,
  affected_id TEXT NOT NULL REFERENCES affected(id),
  kind TEXT NOT NULL,                     -- refund | payout
  capture_id TEXT, email TEXT,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  request_id TEXT NOT NULL UNIQUE,        -- sent to PayPal as PayPal-Request-Id; stored BEFORE the call
  paypal_id TEXT, state TEXT NOT NULL DEFAULT 'queued',  -- queued | completed | pending | unclaimed | failed
  error TEXT, updated_at TEXT NOT NULL,
  UNIQUE(incident_id, affected_id, kind)
);

CREATE TABLE IF NOT EXISTS claim (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incident(id),
  email TEXT NOT NULL, order_ref TEXT, batch_code TEXT, text TEXT NOT NULL,
  match_status TEXT NOT NULL,             -- matched | unmatched | duplicate
  affected_id TEXT, ai_json TEXT, flags_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL,                 -- review | approved | rejected | moved-to-records
  decided_by TEXT, decision_note TEXT,
  status_token TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY, incident_id TEXT, actor TEXT NOT NULL,  -- ai | rule | person | paypal | sample
  kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_event (
  paypal_event_id TEXT PRIMARY KEY, type TEXT, verified INTEGER, payload TEXT, at TEXT
);
`);

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
export const token = () => crypto.randomBytes(16).toString("hex");
export const now = () => new Date().toISOString();

export type Actor = "ai" | "rule" | "person" | "paypal" | "sample";

export function logEvent(incidentId: string | null, actor: Actor, kind: string, detail: string) {
  db.prepare("INSERT INTO event_log (incident_id, actor, kind, detail, at) VALUES (?,?,?,?,?)").run(incidentId, actor, kind, detail, now());
}

/** Run `fn` inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const all = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as T[];
export const get = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...(params as never[])) as T | undefined;
export const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...(params as never[]));
