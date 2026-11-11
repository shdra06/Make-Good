// Approval manifests.
//
// A person does not approve "a batch". They approve one exact list: every
// recipient, amount, PayPal payment reference, rule and piece of evidence,
// plus the customers the list leaves out and why. That list is the manifest.
//
//   - It is written once and never changed (the database refuses updates).
//   - Its hash is what an approval is bound to.
//   - The payment worker refuses any operation that is not on the approved
//     manifest, or whose details differ from it.
//   - If anything the manifest rests on changes (the rules, a customer's
//     match, an amount, the refundable balance of a payment), the manifest is
//     invalidated, the approval with it, and a person must review a new
//     version.

import { createHash } from "node:crypto";
import { audit, type AuditEvent } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json, placeholders } from "../../platform/db/db.ts";
import { fromMinor } from "../../platform/money.ts";
import type { BatchTotals, HeldItem, PlannedItem } from "./batches.ts";

export type Deps = { db: Db; clock: Clock };
type Actor = AuditEvent["actor"];

export type ManifestEvidence = { dimension: string; kind: string; source: string; recordId: string | null; fact: string; strength: string };

export type ManifestItem = {
  n: number;
  /** The stable identifier of this movement of money. Also sent to PayPal as the request ID. */
  operationId: string;
  requestId: string;
  candidateId: string;
  kind: "refund" | "payout";
  /** The original PayPal payment a refund goes back to. */
  captureId: string | null;
  recipientType: "EMAIL" | "PAYPAL_ID" | null;
  recipient: string | null;
  currency: string;
  amountMinor: number;
  amount: string;
  orderId: string | null;
  orderNumber: string | null;
  orderLineId: string | null;
  sku: string | null;
  lineTitle: string | null;
  affectedQuantity: number;
  customerName: string | null;
  customerEmail: string | null;
  paymentIdentity: string;
  eligibility: string;
  decision: string;
  /** How the record came to be payable: by the records alone, or confirmed by a named person. */
  confirmedBy: string | null;
  confirmationBasis: string | null;
  confirmationNote: string | null;
  reason: string;
  calculationId: string;
  entitlementMinor: number;
  alreadyRefundedMinor: number;
  /** The original payment and what had been refunded on it when this list was built. */
  captureGrossMinor: number | null;
  captureRefundedBeforeMinor: number | null;
  evidence: ManifestEvidence[];
};

export type ManifestContent = {
  schema: "makegood.approval-manifest/1";
  batch: { id: string; name: string; kind: "refund" | "payout" };
  incident: { id: string; title: string; kind: string };
  version: number;
  createdAt: string;
  createdBy: { id: string; name: string | null };
  /** Where the money would move: "sandbox", "live" or "simulator". A simulator manifest moves no real money. */
  environment: string;
  rule: { ruleVersionId: string; version: number; scope: unknown; compensation: unknown };
  items: ManifestItem[];
  /** Affected or possibly affected customers this list does not pay, each with the reason. */
  notIncluded: HeldItem[];
  totals: BatchTotals;
  /** One line per customer record in the incident, as it stood. A change to any line invalidates this manifest. */
  cohort: Record<string, string>;
  previous: { version: number; contentHash: string; invalidatedBecause: Drift[] } | null;
};

export type Drift = {
  kind:
    | "rule_changed"
    | "customer_added"
    | "customer_changed"
    | "balance_changed"
    | "dispute_opened"
    | "operation_changed";
  candidateId?: string;
  detail: string;
};

/** JSON with object keys in a fixed order, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const hashManifest = (content: ManifestContent): string =>
  createHash("sha256").update(canonicalJson(content)).digest("hex");

/**
 * One line per customer record of an incident: its workflow status, the two
 * answers, the decision, the rules it was matched under, and what it would be
 * paid. Records shown not to be affected are left out.
 */
export async function cohortSnapshot(q: Queryable, orgId: string, incidentId: string): Promise<Record<string, string>> {
  const rows = await q.query<{
    id: string; status: string; payment_identity: string; eligibility: string; decision: string; rule_version_id: string;
    route: string | null; payable_minor: number | null; currency: string | null; capture_id: string | null;
  }>(
    `select c.id, c.status, c.payment_identity, c.eligibility, c.decision, c.rule_version_id,
            k.route, k.payable_minor, trim(k.currency) as currency, p.transaction_id as capture_id
       from candidates c
       left join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
       left join payment_transactions p on p.org_id = c.org_id and p.id = c.payment_transaction_id
      where c.org_id = $1 and c.incident_id = $2 and c.status <> 'cleared'`,
    [orgId, incidentId],
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.id] = [
      r.status, r.payment_identity, r.eligibility, r.decision, r.rule_version_id,
      r.route ?? "-", r.payable_minor ?? "-", r.currency ?? "-", r.capture_id ?? "-",
    ].join("|");
  }
  return out;
}

const SNAPSHOT_FIELDS = ["status", "payment", "eligibility", "decision", "rules", "route", "amount", "currency", "PayPal payment"] as const;

function describeChange(before: string, after: string): string {
  const a = before.split("|");
  const b = after.split("|");
  const parts: string[] = [];
  for (const [i, name] of SNAPSHOT_FIELDS.entries()) {
    if (a[i] !== b[i]) parts.push(name === "rules" ? "matched under different rules" : `${name}: ${a[i]} became ${b[i]}`);
  }
  return parts.join("; ");
}

const DESCRIBE_RULE: Record<string, (r: Record<string, unknown>) => string> = {
  full_refund: () => "full refund of the affected units",
  percent: (r) => `${Number(r.percentBps) / 100}% of the affected units`,
  fixed_per_unit: (r) => `${fromMinor(Number(r.fixedMinor), String(r.fixedCurrency))} ${String(r.fixedCurrency)} for each affected unit`,
  fixed_per_customer: (r) => `${fromMinor(Number(r.fixedMinor), String(r.fixedCurrency))} ${String(r.fixedCurrency)} for each customer`,
  pro_rata: () => "the share of the paid period that was lost",
  overcharge_difference: () => "the amount charged above the correct price",
  duplicate_payment: () => "the whole of the payment that was taken twice",
};

/** The compensation rule in words, for the reason stored with every planned payment. */
export function describeRule(rule: unknown): string {
  const r = (rule ?? {}) as Record<string, unknown>;
  return (DESCRIBE_RULE[String(r.type)] ?? (() => "compensation under the incident's rule"))(r);
}

export type ManifestRow = {
  id: string; batch_id: string; version: number; status: "current" | "invalidated" | "superseded"; content: ManifestContent;
  content_hash: string; item_count: number; created_at: Date; invalidated_at: Date | null; invalidated_reason: Drift[] | null;
};

const MANIFEST_COLUMNS = "id, batch_id, version, status, content, content_hash, item_count, created_at, invalidated_at, invalidated_reason";

export async function currentManifest(q: Queryable, orgId: string, batchId: string): Promise<ManifestRow | null> {
  const rows = await q.query<ManifestRow>(
    `select ${MANIFEST_COLUMNS} from approval_manifests where org_id = $1 and batch_id = $2 and status = 'current'`,
    [orgId, batchId],
  );
  return rows[0] ?? null;
}

export async function listManifests(q: Queryable, orgId: string, batchId: string) {
  return q.query<Omit<ManifestRow, "content">>(
    `select id, batch_id, version, status, content_hash, item_count, created_at, invalidated_at, invalidated_reason
       from approval_manifests where org_id = $1 and batch_id = $2 order by version desc`,
    [orgId, batchId],
  );
}

export async function manifestByVersion(q: Queryable, orgId: string, batchId: string, version: number): Promise<ManifestRow | null> {
  const rows = await q.query<ManifestRow>(
    `select ${MANIFEST_COLUMNS} from approval_manifests where org_id = $1 and batch_id = $2 and version = $3`,
    [orgId, batchId, version],
  );
  return rows[0] ?? null;
}

/**
 * Writes the next manifest version for a batch. `items` must already carry
 * the operation IDs: the manifest names the exact operations the worker will
 * be allowed to send.
 */
export async function writeManifest(
  tx: Queryable,
  input: {
    orgId: string; batchId: string; userId: string; now: Date;
    items: Array<PlannedItem & { operationId: string; requestId: string }>;
    held: HeldItem[]; totals: BatchTotals;
  },
): Promise<{ id: string; version: number; contentHash: string }> {
  const [batch] = await tx.query<{ name: string; kind: "refund" | "payout"; incident_id: string; manifest_version: number }>(
    "select name, kind, incident_id, manifest_version from batches where org_id = $1 and id = $2",
    [input.orgId, input.batchId],
  );
  const [incident] = await tx.query<{ id: string; title: string; kind: string }>(
    "select id, title, kind from incidents where org_id = $1 and id = $2",
    [input.orgId, batch!.incident_id],
  );
  const [rule] = await tx.query<{ id: string; version: number; scope: unknown; compensation: unknown }>(
    "select id, version, scope, compensation from incident_rule_versions where org_id = $1 and incident_id = $2 order by version desc limit 1",
    [input.orgId, batch!.incident_id],
  );
  const [user] = await tx.query<{ name: string | null }>("select name from users where id = $1", [input.userId]);
  const [connection] = await tx.query<{ environment: string }>(
    "select environment from paypal_connections where org_id = $1 and status = 'connected' order by (environment = 'live') desc, created_at limit 1",
    [input.orgId],
  );
  const [previous] = await tx.query<{ version: number; content_hash: string; invalidated_reason: Drift[] | null }>(
    "select version, content_hash, invalidated_reason from approval_manifests where org_id = $1 and batch_id = $2 order by version desc limit 1",
    [input.orgId, input.batchId],
  );

  const evidenceRows = input.items.length === 0 ? [] : await tx.query<ManifestEvidence & { candidate_id: string }>(
    `select candidate_id, dimension, kind, source, record_id as "recordId", fact, strength
       from match_evidence where org_id = $1 and candidate_id in (${placeholders(input.items.length, 1)}) order by created_at, id`,
    [input.orgId, ...input.items.map((i) => i.candidateId)],
  );
  const evidenceOf = new Map<string, ManifestEvidence[]>();
  for (const { candidate_id, ...e } of evidenceRows) evidenceOf.set(candidate_id, [...(evidenceOf.get(candidate_id) ?? []), e]);

  const version = (batch!.manifest_version ?? 0) + 1;
  const content: ManifestContent = {
    schema: "makegood.approval-manifest/1",
    batch: { id: input.batchId, name: batch!.name, kind: batch!.kind },
    incident: { id: incident!.id, title: incident!.title, kind: incident!.kind },
    version,
    createdAt: input.now.toISOString(),
    createdBy: { id: input.userId, name: user?.name ?? null },
    environment: connection?.environment ?? "none",
    rule: { ruleVersionId: rule!.id, version: rule!.version, scope: rule!.scope, compensation: rule!.compensation },
    items: input.items.map((i, index): ManifestItem => ({
      n: index + 1,
      operationId: i.operationId,
      requestId: i.requestId,
      candidateId: i.candidateId,
      kind: i.kind,
      captureId: i.captureId,
      recipientType: i.recipientType,
      recipient: i.recipient,
      currency: i.currency,
      amountMinor: i.amountMinor,
      amount: fromMinor(i.amountMinor, i.currency),
      orderId: i.orderId,
      orderNumber: i.orderNumber,
      orderLineId: i.orderLineId,
      sku: i.sku,
      lineTitle: i.lineTitle,
      affectedQuantity: i.affectedQuantity,
      customerName: i.customerName,
      customerEmail: i.customerEmail,
      paymentIdentity: i.paymentIdentity,
      eligibility: i.eligibility,
      decision: i.decision,
      confirmedBy: i.decidedByName,
      confirmationBasis: i.decisionBasis,
      confirmationNote: i.decisionNote,
      reason: i.reason,
      calculationId: i.calculationId,
      entitlementMinor: i.entitlementMinor,
      alreadyRefundedMinor: i.alreadyRefundedMinor,
      captureGrossMinor: i.captureGrossMinor,
      captureRefundedBeforeMinor: i.captureRefundedMinor,
      evidence: evidenceOf.get(i.candidateId) ?? [],
    })),
    notIncluded: input.held,
    totals: input.totals,
    cohort: await cohortSnapshot(tx, input.orgId, batch!.incident_id),
    previous: previous
      ? { version: previous.version, contentHash: previous.content_hash, invalidatedBecause: previous.invalidated_reason ?? [] }
      : null,
  };
  const contentHash = hashManifest(content);
  // Any earlier version that is still current is replaced by this one.
  await tx.query(
    `update approval_manifests set status = 'superseded', invalidated_at = $3
      where org_id = $1 and batch_id = $2 and status = 'current'`,
    [input.orgId, input.batchId, input.now.toISOString()],
  );
  const [row] = await tx.query<{ id: string }>(
    `insert into approval_manifests (org_id, batch_id, version, content, content_hash, item_count, created_by, created_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) returning id`,
    [input.orgId, input.batchId, version, json(content), contentHash, content.items.length, input.userId, input.now.toISOString()],
  );
  await tx.query("update batches set manifest_version = $3, approved_manifest_id = null where org_id = $1 and id = $2", [
    input.orgId, input.batchId, version,
  ]);
  await tx.query(
    "update payment_operations set manifest_id = $3, manifest_version = $4 where org_id = $1 and batch_id = $2 and state = 'planned'",
    [input.orgId, input.batchId, row!.id, version],
  );
  return { id: row!.id, version, contentHash };
}

/**
 * Compares a batch's current manifest with the records as they are now.
 * Returns every difference that matters. Null means the batch has no current
 * manifest at all.
 */
export async function manifestDrift(q: Queryable, orgId: string, batchId: string): Promise<Drift[] | null> {
  const manifest = await currentManifest(q, orgId, batchId);
  if (!manifest) return null;
  const content = manifest.content;
  const drifts: Drift[] = [];

  const [rule] = await q.query<{ id: string; version: number }>(
    "select id, version from incident_rule_versions where org_id = $1 and incident_id = $2 order by version desc limit 1",
    [orgId, content.incident.id],
  );
  if (rule && rule.id !== content.rule.ruleVersionId) {
    drifts.push({ kind: "rule_changed", detail: `The rules are now at version ${rule.version}. This list was built under version ${content.rule.version}.` });
  }

  // Customers who are being paid, or were paid, through another batch are that batch's business.
  const elsewhere = new Set(
    (await q.query<{ candidate_id: string }>(
      `select distinct candidate_id from payment_operations
        where org_id = $1 and incident_id = $2 and batch_id <> $3
          and state in ('queued', 'submitting', 'unknown', 'pending_provider', 'succeeded')`,
      [orgId, content.incident.id, batchId],
    )).map((r) => r.candidate_id),
  );
  const now = await cohortSnapshot(q, orgId, content.incident.id);
  const labels = new Map(
    (await q.query<{ id: string; label: string }>(
      `select c.id, coalesce(o.order_number, c.customer_email, c.subject_key) as label
         from candidates c left join orders o on o.org_id = c.org_id and o.id = c.order_id
        where c.org_id = $1 and c.incident_id = $2`,
      [orgId, content.incident.id],
    )).map((r) => [r.id, r.label]),
  );
  for (const [id, line] of Object.entries(now)) {
    if (elsewhere.has(id)) continue;
    const before = content.cohort[id];
    if (before === undefined) {
      drifts.push({ kind: "customer_added", candidateId: id, detail: `${labels.get(id) ?? id} was matched after this list was built.` });
    } else if (before !== line) {
      drifts.push({ kind: "customer_changed", candidateId: id, detail: `${labels.get(id) ?? id}: ${describeChange(before, line)}.` });
    }
  }

  const captures = content.items.filter((i) => i.kind === "refund" && i.captureId);
  if (captures.length > 0) {
    const rows = await q.query<{ transaction_id: string; refunded_minor: number; dispute_state: string | null }>(
      `select transaction_id, refunded_minor, dispute_state from payment_transactions
        where org_id = $1 and kind = 'payment' and transaction_id in (${placeholders(captures.length, 1)})`,
      [orgId, ...captures.map((i) => i.captureId)],
    );
    const live = new Map(rows.map((r) => [r.transaction_id, r]));
    for (const item of captures) {
      const p = live.get(item.captureId!);
      if (!p) continue;
      if (p.dispute_state === "open") {
        drifts.push({ kind: "dispute_opened", candidateId: item.candidateId, detail: `A PayPal dispute is now open on payment ${item.captureId}.` });
      }
      if (item.captureRefundedBeforeMinor !== null && p.refunded_minor !== item.captureRefundedBeforeMinor) {
        drifts.push({
          kind: "balance_changed", candidateId: item.candidateId,
          detail: `Payment ${item.captureId} had ${fromMinor(item.captureRefundedBeforeMinor, item.currency)} ${item.currency} refunded when this list was built. It now has ${fromMinor(p.refunded_minor, item.currency)}.`,
        });
      }
    }
  }

  const ops = await q.query<{ id: string; kind: string; capture_id: string | null; recipient: string | null; currency: string; amount_minor: number; state: string }>(
    `select id, kind, capture_id, recipient, trim(currency) as currency, amount_minor, state
       from payment_operations where org_id = $1 and batch_id = $2 and state <> 'cancelled'`,
    [orgId, batchId],
  );
  const byId = new Map(ops.map((o) => [o.id, o]));
  for (const item of content.items) {
    const op = byId.get(item.operationId);
    byId.delete(item.operationId);
    if (!op) {
      drifts.push({ kind: "operation_changed", candidateId: item.candidateId, detail: `The payment for ${item.orderNumber ?? item.candidateId} is no longer in the batch.` });
    } else if (op.kind !== item.kind || op.capture_id !== item.captureId || op.recipient !== item.recipient || op.currency !== item.currency || op.amount_minor !== item.amountMinor) {
      drifts.push({ kind: "operation_changed", candidateId: item.candidateId, detail: `The payment for ${item.orderNumber ?? item.candidateId} no longer matches the list (amount, recipient or payment reference).` });
    }
  }
  for (const extra of byId.values()) {
    drifts.push({ kind: "operation_changed", detail: `Payment operation ${extra.id} is in the batch but not on the list.` });
  }
  return drifts;
}

/** Withdraws the current manifest and any approval given on it, and sends the batch back to draft. */
export async function invalidateManifest(
  tx: Queryable,
  input: { orgId: string; batchId: string; drifts: Drift[]; actor: Actor; now: Date },
): Promise<boolean> {
  const rows = await tx.query<{ id: string; version: number }>(
    `update approval_manifests set status = 'invalidated', invalidated_at = $3, invalidated_reason = $4::jsonb
      where org_id = $1 and batch_id = $2 and status = 'current' returning id, version`,
    [input.orgId, input.batchId, input.now.toISOString(), json(input.drifts.slice(0, 200))],
  );
  if (!rows[0]) return false;
  await tx.query(
    `update batches set status = 'draft', approved_manifest_id = null, submitted_at = null, approved_at = null
      where org_id = $1 and id = $2 and status in ('draft', 'pending_approval', 'approved')`,
    [input.orgId, input.batchId],
  );
  await audit(tx, {
    orgId: input.orgId, actor: input.actor, action: "batch.approval_invalidated", entityType: "batch", entityId: input.batchId,
    data: { manifestId: rows[0].id, version: rows[0].version, changes: input.drifts.length, because: input.drifts.slice(0, 25) },
    at: input.now,
  });
  return true;
}

export type ManifestCheck =
  | { ok: true; manifest: { id: string; version: number; contentHash: string } }
  | { ok: false; reason: "no_current_manifest" | "invalidated" | "operations_differ"; drifts: Drift[] };

/**
 * Checks a batch that has not started. If what it would pay has changed, the
 * manifest is invalidated here, in its own transaction, so the withdrawal is
 * recorded even though the caller's action is then refused.
 */
export async function checkManifest(deps: Deps, input: { orgId: string; batchId: string; actor: Actor }): Promise<ManifestCheck> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx): Promise<ManifestCheck> => {
    const [batch] = await tx.query<{ status: string }>("select status from batches where org_id = $1 and id = $2 for update", [input.orgId, input.batchId]);
    const drifts = await manifestDrift(tx, input.orgId, input.batchId);
    if (drifts === null) return { ok: false, reason: "no_current_manifest", drifts: [] };
    if (drifts.length === 0 || !batch || !["draft", "pending_approval", "approved"].includes(batch.status)) {
      const manifest = (await currentManifest(tx, input.orgId, input.batchId))!;
      return { ok: true, manifest: { id: manifest.id, version: manifest.version, contentHash: manifest.content_hash } };
    }
    // Payment rows that differ from the list were edited behind the application's back. That is
    // an integrity failure, not a change of circumstances: refuse, and leave the evidence in place.
    if (drifts.every((d) => d.kind === "operation_changed")) return { ok: false, reason: "operations_differ", drifts };
    await invalidateManifest(tx, { orgId: input.orgId, batchId: input.batchId, drifts, actor: input.actor, now });
    return { ok: false, reason: "invalidated", drifts };
  });
}

/**
 * After anything that can change who is owed what (a match run, new rules, a
 * person's decision), every batch of the incident that has not started is
 * checked. Returns the batches whose approval was withdrawn.
 */
export async function revalidateOpenBatches(deps: Deps, input: { orgId: string; incidentId: string }): Promise<string[]> {
  const batches = await deps.db.query<{ id: string }>(
    "select id from batches where org_id = $1 and incident_id = $2 and status in ('draft', 'pending_approval', 'approved')",
    [input.orgId, input.incidentId],
  );
  const invalidated: string[] = [];
  for (const b of batches) {
    const check = await checkManifest(deps, { orgId: input.orgId, batchId: b.id, actor: { kind: "system" } });
    if (!check.ok && check.reason === "invalidated") invalidated.push(b.id);
  }
  return invalidated;
}

type GuardedOperation = {
  id: string; org_id: string; batch_id: string; candidate_id: string; kind: "refund" | "payout"; capture_id: string | null;
  recipient: string | null; currency: string; amount_minor: number;
};

/**
 * The last check, made by the worker immediately before it asks PayPal to
 * move money. Returns null to go ahead, or the reason the payment must be
 * withheld. An approval does not survive a change to what it approved.
 */
export async function executionGuard(tx: Queryable, op: GuardedOperation): Promise<string | null> {
  const [row] = await tx.query<{
    approved_manifest_id: string | null; manifest_id: string | null; calculation_id: string; capture_refunded_before_minor: number | null;
    manifest_status: string | null; item: Partial<ManifestItem> | null;
    candidate_status: string; payment_identity: string; current_calculation_id: string | null;
    refunded_minor: number | null; dispute_state: string | null;
  }>(
    `select b.approved_manifest_id, op.manifest_id, op.calculation_id, op.capture_refunded_before_minor,
            m.status as manifest_status,
            jsonb_path_query_first(m.content, '$.items[*] ? (@.operationId == $id)', jsonb_build_object('id', op.id::text)) as item,
            c.status as candidate_status, c.payment_identity,
            (select k.id from compensation_calculations k where k.org_id = op.org_id and k.candidate_id = op.candidate_id and k.is_current) as current_calculation_id,
            p.refunded_minor, p.dispute_state
       from payment_operations op
       join batches b on b.org_id = op.org_id and b.id = op.batch_id
       join candidates c on c.org_id = op.org_id and c.id = op.candidate_id
       left join approval_manifests m on m.org_id = b.org_id and m.id = b.approved_manifest_id
       left join payment_transactions p on p.org_id = op.org_id and p.kind = 'payment' and p.transaction_id = op.capture_id
      where op.id = $1`,
    [op.id],
  );
  if (!row) return "The operation could not be found.";
  if (!row.approved_manifest_id || row.manifest_status !== "current") return "The batch has no approved payment list in force.";
  if (row.manifest_id !== row.approved_manifest_id) return "This payment is not on the approved payment list.";
  const item = row.item;
  if (!item) return "This payment is not on the approved payment list.";
  if (
    item.kind !== op.kind || (item.captureId ?? null) !== op.capture_id || (item.recipient ?? null) !== op.recipient ||
    item.currency !== op.currency || item.amountMinor !== op.amount_minor
  ) {
    return "The payment no longer matches the approved payment list (amount, recipient or payment reference).";
  }
  if (row.candidate_status !== "confirmed") return `The customer record is now "${row.candidate_status}". It was confirmed when the list was approved.`;
  if (op.kind === "refund" && row.payment_identity !== "verified") return "It is no longer settled which PayPal payment paid for this order.";
  if (row.current_calculation_id !== row.calculation_id) return "The amount owed was recalculated after the list was approved.";
  if (op.kind === "refund") {
    if (row.dispute_state === "open") return "A PayPal dispute was opened on the payment after the list was approved.";
    if (row.capture_refunded_before_minor !== null && row.refunded_minor !== null && row.refunded_minor !== row.capture_refunded_before_minor) {
      return "The refundable balance of the payment changed after the list was approved.";
    }
  }
  return null;
}

/** The approved list as a spreadsheet: one row per payment, in the order it will be sent. */
export function manifestCsv(content: ManifestContent, contentHash: string): string {
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    // A leading =, +, - or @ would be read as a formula by a spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = [
    "n", "operation_id", "kind", "paypal_capture_id", "recipient", "currency", "amount", "order_number", "sku", "units",
    "customer_name", "customer_email", "payment_identity", "eligibility", "confirmed_by", "confirmation_basis", "reason",
    "manifest_version", "manifest_sha256",
  ];
  const lines = [header.join(",")];
  for (const i of content.items) {
    lines.push([
      i.n, i.operationId, i.kind, i.captureId, i.recipient, i.currency, i.amount, i.orderNumber, i.sku, i.affectedQuantity,
      i.customerName, i.customerEmail, i.paymentIdentity, i.eligibility, i.confirmedBy, i.confirmationBasis, i.reason,
      content.version, contentHash,
    ].map(cell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
