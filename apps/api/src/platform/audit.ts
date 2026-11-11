// The audit trail. Every decision that touches money or access is written
// here, in the same transaction as the change it describes.
//
// Rows are chained: each carries a hash of the previous row for the same
// organisation, so a missing or altered row shows up when the chain is checked.
// The database also refuses UPDATE and DELETE on this table.

import { createHash } from "node:crypto";
import type { Queryable } from "./db/db.ts";
import { json } from "./db/db.ts";

export type AuditEvent = {
  orgId: string | null;
  actor: { kind: "user"; userId: string } | { kind: "system" | "customer" | "ai" | "provider" };
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
  at: Date;
};

/** JSON with object keys sorted, so the same data always produces the same text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function chainHash(prev: string | null, event: AuditEvent): string {
  const material = JSON.stringify([
    prev,
    event.orgId,
    event.actor.kind,
    "userId" in event.actor ? event.actor.userId : null,
    event.action,
    event.entityType,
    event.entityId ?? null,
    canonical(event.data ?? {}),
    event.at.toISOString(),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** Must be called inside a transaction: the lock that orders the chain lasts until commit. */
export async function audit(tx: Queryable, event: AuditEvent): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`audit:${event.orgId ?? "global"}`]);
  const last = await tx.query<{ hash: string }>(
    "select hash from audit_events where org_id is not distinct from $1 order by id desc limit 1",
    [event.orgId],
  );
  const prev = last[0]?.hash ?? null;
  await tx.query(
    `insert into audit_events (org_id, actor_kind, actor_user_id, action, entity_type, entity_id, data, ip, created_at, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      event.orgId,
      event.actor.kind,
      "userId" in event.actor ? event.actor.userId : null,
      event.action,
      event.entityType,
      event.entityId ?? null,
      json(event.data ?? {}),
      event.ip ?? null,
      event.at.toISOString(),
      prev,
      chainHash(prev, event),
    ],
  );
}

export type ChainCheck = { ok: true; rows: number } | { ok: false; rows: number; brokenAtId: number };

/** Recomputes the chain for one organisation and reports the first row that does not fit. */
export async function verifyAuditChain(q: Queryable, orgId: string | null): Promise<ChainCheck> {
  const rows = await q.query<{
    id: number; actor_kind: AuditEvent["actor"]["kind"]; actor_user_id: string | null; action: string;
    entity_type: string; entity_id: string | null; data: Record<string, unknown>; created_at: Date;
    prev_hash: string | null; hash: string;
  }>(
    `select id, actor_kind, actor_user_id, action, entity_type, entity_id, data, created_at, prev_hash, hash
       from audit_events where org_id is not distinct from $1 order by id`,
    [orgId],
  );
  let prev: string | null = null;
  for (const row of rows) {
    const expected = chainHash(prev, {
      orgId,
      actor: row.actor_kind === "user" ? { kind: "user", userId: row.actor_user_id ?? "" } : { kind: row.actor_kind },
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      data: row.data,
      at: new Date(row.created_at),
    });
    if (row.prev_hash !== prev || row.hash !== expected) return { ok: false, rows: rows.length, brokenAtId: row.id };
    prev = row.hash;
  }
  return { ok: true, rows: rows.length };
}
