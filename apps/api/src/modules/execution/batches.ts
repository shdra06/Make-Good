// Batches: the controlled path from "these customers are owed money" to
// "pay them".  preview ─▶ create ─▶ submit ─▶ approve ─▶ start
//
// Nothing here calls PayPal. Starting a batch only queues operations; the
// executor (executor.ts) carries them out.

import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import { enqueue } from "../../platform/jobs/queue.ts";
import { assertBatchTransition, type BatchStatus } from "./state.ts";

export type Deps = { db: Db; clock: Clock };

export const ApprovalPolicy = z.object({
  /** The person who created a batch cannot be the one who approves it. */
  dualControl: z.boolean().default(false),
  approvalsRequired: z.number().int().min(1).max(3).default(1),
  /** Batches above this total need `largeBatchApprovalsRequired` approvals. In the organisation's currency. */
  largeBatchMinor: z.number().int().positive().nullable().default(null),
  largeBatchApprovalsRequired: z.number().int().min(1).max(3).default(2),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const APPROVER_ROLES: readonly string[] = ["owner", "admin", "finance_approver"];

export type PlannedItem = {
  candidateId: string;
  calculationId: string;
  kind: "refund" | "payout";
  captureId: string | null;
  recipientType: "EMAIL" | "PAYPAL_ID" | null;
  recipient: string | null;
  currency: string;
  amountMinor: number;
  classification: string;
  customerEmail: string | null;
};

export type BatchTotals = {
  count: number;
  byCurrency: Record<string, { count: number; amountMinor: number }>;
  byKind: Record<string, number>;
  byClassification: Record<string, number>;
};

export type BatchPreview = {
  items: PlannedItem[];
  totals: BatchTotals;
  totalsHash: string;
  /** Affected customers this batch does not pay, and why. */
  notIncluded: Record<string, number>;
};

export function totalsOf(items: readonly PlannedItem[]): BatchTotals {
  const totals: BatchTotals = { count: items.length, byCurrency: {}, byKind: {}, byClassification: {} };
  for (const item of items) {
    const c = (totals.byCurrency[item.currency] ??= { count: 0, amountMinor: 0 });
    c.count++;
    c.amountMinor += item.amountMinor;
    totals.byKind[item.kind] = (totals.byKind[item.kind] ?? 0) + 1;
    totals.byClassification[item.classification] = (totals.byClassification[item.classification] ?? 0) + 1;
  }
  return totals;
}

/** A fingerprint of exactly what will be paid to whom. Approvals are bound to it. */
export function totalsHash(items: readonly Pick<PlannedItem, "candidateId" | "kind" | "captureId" | "recipient" | "currency" | "amountMinor">[]): string {
  const lines = items
    .map((i) => [i.candidateId, i.kind, i.captureId ?? "", i.recipient ?? "", i.currency, i.amountMinor].join("|"))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Works out what a batch for this incident would pay, without writing
 * anything or contacting PayPal. This is the dry run.
 */
export async function previewBatch(q: Queryable, orgId: string, incidentId: string): Promise<BatchPreview> {
  const rows = await q.query<{
    candidate_id: string; status: string; classification: string; customer_email: string | null;
    calculation_id: string | null; route: string | null; payable_minor: number | null; currency: string | null;
    steps: { recipient?: { type: "EMAIL" | "PAYPAL_ID"; value: string } | null } | null;
    capture_id: string | null; has_live_operation: boolean;
  }>(
    `select c.id as candidate_id, c.status, c.classification, c.customer_email,
            k.id as calculation_id, k.route, k.payable_minor, trim(k.currency) as currency, k.steps,
            p.transaction_id as capture_id,
            exists (select 1 from payment_operations op
                     where op.org_id = c.org_id and op.candidate_id = c.id
                       and op.state in ('planned','queued','submitting','unknown','pending_provider','succeeded','failed_retryable')) as has_live_operation
       from candidates c
       left join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
       left join payment_transactions p on p.org_id = c.org_id and p.id = c.payment_transaction_id
      where c.org_id = $1 and c.incident_id = $2
      order by c.created_at, c.id`,
    [orgId, incidentId],
  );
  const items: PlannedItem[] = [];
  const notIncluded: Record<string, number> = {};
  const skip = (why: string) => (notIncluded[why] = (notIncluded[why] ?? 0) + 1);
  for (const r of rows) {
    if (r.status === "excluded") skip("excluded");
    else if (r.status === "declined") skip("declined");
    else if (r.status === "proposed") skip("waiting_for_confirmation");
    else if (r.has_live_operation) skip("already_in_a_batch_or_paid");
    else if (!r.calculation_id || r.route === "none" || !r.payable_minor) skip("nothing_to_pay");
    else if (r.route === "manual") skip("needs_manual_handling");
    else if (r.route === "refund_original") {
      if (!r.capture_id) skip("needs_manual_handling");
      else items.push({
        candidateId: r.candidate_id, calculationId: r.calculation_id, kind: "refund", captureId: r.capture_id,
        recipientType: null, recipient: null, currency: r.currency!, amountMinor: r.payable_minor,
        classification: r.classification, customerEmail: r.customer_email,
      });
    } else {
      const recipient = r.steps?.recipient;
      if (!recipient) skip("needs_manual_handling");
      else items.push({
        candidateId: r.candidate_id, calculationId: r.calculation_id, kind: "payout", captureId: null,
        recipientType: recipient.type, recipient: recipient.value, currency: r.currency!, amountMinor: r.payable_minor,
        classification: r.classification, customerEmail: r.customer_email,
      });
    }
  }
  return { items, totals: totalsOf(items), totalsHash: totalsHash(items), notIncluded };
}

type BatchRow = {
  id: string; org_id: string; incident_id: string; rule_version_id: string; status: BatchStatus;
  totals: BatchTotals; totals_hash: string | null; created_by: string | null;
};

async function lockBatch(tx: Queryable, orgId: string, batchId: string): Promise<BatchRow> {
  const rows = await tx.query<BatchRow>(
    "select id, org_id, incident_id, rule_version_id, status, totals, totals_hash, created_by from batches where org_id = $1 and id = $2 for update",
    [orgId, batchId],
  );
  if (!rows[0]) throw new NotFoundError("Batch");
  return rows[0];
}

async function currentItems(tx: Queryable, orgId: string, batchId: string) {
  return tx.query<{ candidateId: string; kind: "refund" | "payout"; captureId: string | null; recipient: string | null; currency: string; amountMinor: number }>(
    `select candidate_id as "candidateId", kind, capture_id as "captureId", recipient, trim(currency) as currency, amount_minor as "amountMinor"
       from payment_operations where org_id = $1 and batch_id = $2`,
    [orgId, batchId],
  );
}

export async function createBatch(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string; name: string },
): Promise<{ id: string; preview: BatchPreview }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const incident = await tx.query<{ id: string; status: string }>(
      "select id, status from incidents where org_id = $1 and id = $2 for update",
      [input.orgId, input.incidentId],
    );
    if (!incident[0]) throw new NotFoundError("Incident");
    const rule = await tx.query<{ id: string }>(
      "select id from incident_rule_versions where org_id = $1 and incident_id = $2 order by version desc limit 1",
      [input.orgId, input.incidentId],
    );
    if (!rule[0]) throw new ValidationError("This incident has no rules yet.");
    const connection = await tx.query<{ id: string }>(
      "select id from paypal_connections where org_id = $1 and status = 'connected' order by (environment = 'live') desc, created_at limit 1",
      [input.orgId],
    );
    if (!connection[0]) {
      throw new ConflictError("NO_PAYPAL_CONNECTION", "Connect a PayPal account before creating a batch.");
    }
    const preview = await previewBatch(tx, input.orgId, input.incidentId);
    if (preview.items.length === 0) {
      throw new ConflictError("NOTHING_TO_PAY", "No confirmed customer is waiting to be paid for this incident.", preview.notIncluded);
    }
    const stale = await tx.query<{ n: number }>(
      `select count(*)::int as n from candidates
        where org_id = $1 and incident_id = $2 and status = 'confirmed' and rule_version_id <> $3`,
      [input.orgId, input.incidentId, rule[0].id],
    );
    if ((stale[0]?.n ?? 0) > 0) {
      throw new ConflictError("RULES_CHANGED", "The rules changed after these customers were matched. Run the match again first.");
    }

    const [batch] = await tx.query<{ id: string }>(
      `insert into batches (org_id, incident_id, rule_version_id, name, totals, totals_hash, created_by, created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning id`,
      [input.orgId, input.incidentId, rule[0].id, input.name, json(preview.totals), preview.totalsHash, input.userId, now.toISOString()],
    );
    for (const item of preview.items) {
      const [op] = await tx.query<{ id: string }>("select gen_random_uuid() as id");
      await tx.query(
        `insert into payment_operations
           (id, org_id, batch_id, candidate_id, calculation_id, kind, paypal_connection_id, capture_id, recipient_type,
            recipient, currency, amount_minor, state, idempotency_key, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned',$13,$14,$14)`,
        [
          op!.id, input.orgId, batch!.id, item.candidateId, item.calculationId, item.kind, connection[0].id, item.captureId,
          item.recipientType, item.recipient, item.currency, item.amountMinor,
          // The key PayPal sees. Fixed for the life of the operation, so a retry can never pay twice.
          `mg-${op!.id}`, now.toISOString(),
        ],
      );
    }
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.created", entityType: "batch",
      entityId: batch!.id, data: { incidentId: input.incidentId, totals: preview.totals, totalsHash: preview.totalsHash }, at: now,
    });
    return { id: batch!.id, preview };
  });
}

async function setBatchStatus(tx: Queryable, batch: BatchRow, to: BatchStatus, now: Date, extra: Record<string, unknown> = {}): Promise<void> {
  assertBatchTransition(batch.status, to);
  const stamp: Partial<Record<BatchStatus, string>> = {
    pending_approval: "submitted_at", approved: "approved_at", executing: "started_at",
    completed: "finished_at", completed_with_failures: "finished_at", cancelled: "finished_at", rejected: "finished_at",
  };
  const column = stamp[to];
  await tx.query(
    `update batches set status = $3, paused_reason = $4 ${column ? `, ${column} = coalesce(${column}, $5)` : ""}
      where org_id = $1 and id = $2`,
    column
      ? [batch.org_id, batch.id, to, (extra.pausedReason as string | undefined) ?? null, now.toISOString()]
      : [batch.org_id, batch.id, to, (extra.pausedReason as string | undefined) ?? null],
  );
  batch.status = to;
}

export async function submitBatch(deps: Deps, input: { orgId: string; batchId: string; userId: string }): Promise<void> {
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    await setBatchStatus(tx, batch, "pending_approval", now);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.submitted", entityType: "batch",
      entityId: batch.id, data: { totalsHash: batch.totals_hash }, at: now,
    });
  });
}

function approvalsNeeded(policy: ApprovalPolicy, totals: BatchTotals, orgCurrency: string): number {
  const inOrgCurrency = totals.byCurrency[orgCurrency]?.amountMinor ?? 0;
  const otherCurrencies = Object.keys(totals.byCurrency).some((c) => c !== orgCurrency);
  // A batch with other currencies cannot be compared to the threshold, so it is treated as large.
  const large = policy.largeBatchMinor !== null && (otherCurrencies || inOrgCurrency > policy.largeBatchMinor);
  return large ? Math.max(policy.approvalsRequired, policy.largeBatchApprovalsRequired) : policy.approvalsRequired;
}

export async function decideBatch(
  deps: Deps,
  input: { orgId: string; batchId: string; userId: string; role: string; decision: "approve" | "reject"; comment?: string },
): Promise<{ status: BatchStatus; approvals: number; needed: number }> {
  const now = deps.clock.now();
  if (!APPROVER_ROLES.includes(input.role)) throw new ForbiddenError("Your role cannot approve payments.");
  return deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    if (batch.status !== "pending_approval") {
      throw new ConflictError("NOT_AWAITING_APPROVAL", `This batch is ${batch.status}, not waiting for approval.`);
    }
    const [org] = await tx.query<{ settings: { approval?: unknown }; default_currency: string }>(
      "select settings, trim(default_currency) as default_currency from organisations where id = $1",
      [input.orgId],
    );
    const policy = ApprovalPolicy.parse(org?.settings?.approval ?? {});
    if (input.decision === "approve" && policy.dualControl && batch.created_by === input.userId) {
      throw new ForbiddenError("This organisation requires a second person: the creator of a batch cannot approve it.");
    }
    // The approval is tied to what is in the batch right now.
    const hash = totalsHash(await currentItems(tx, input.orgId, input.batchId));
    if (hash !== batch.totals_hash) {
      throw new ConflictError("BATCH_CHANGED", "The contents of this batch changed after it was submitted. Create it again.");
    }
    await tx.query(
      `insert into batch_approvals (org_id, batch_id, user_id, decision, comment, totals_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (org_id, batch_id, user_id) do update set decision = excluded.decision, comment = excluded.comment,
         totals_hash = excluded.totals_hash, created_at = excluded.created_at`,
      [input.orgId, input.batchId, input.userId, input.decision, input.comment ?? null, hash, now.toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `batch.${input.decision}`,
      entityType: "batch", entityId: batch.id, data: { totalsHash: hash, comment: input.comment ?? null }, at: now,
    });
    const needed = approvalsNeeded(policy, batch.totals, org!.default_currency);
    if (input.decision === "reject") {
      await setBatchStatus(tx, batch, "rejected", now);
      await tx.query("update payment_operations set state = 'cancelled', updated_at = $3, completed_at = $3 where org_id = $1 and batch_id = $2 and state = 'planned'", [
        input.orgId, input.batchId, now.toISOString(),
      ]);
      return { status: batch.status, approvals: 0, needed };
    }
    const [count] = await tx.query<{ n: number }>(
      "select count(*)::int as n from batch_approvals where org_id = $1 and batch_id = $2 and decision = 'approve' and totals_hash = $3",
      [input.orgId, input.batchId, hash],
    );
    if ((count?.n ?? 0) >= needed) await setBatchStatus(tx, batch, "approved", now);
    return { status: batch.status, approvals: count?.n ?? 0, needed };
  });
}

/** How far apart operations are released, so we stay under the provider's rate limit. */
const DEFAULT_SPACING_MS = 250;

export async function startBatch(
  deps: Deps,
  input: { orgId: string; batchId: string; userId: string; spacingMs?: number },
): Promise<{ queued: number }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    const hash = totalsHash(await currentItems(tx, input.orgId, input.batchId));
    if (hash !== batch.totals_hash) {
      throw new ConflictError("BATCH_CHANGED", "The contents of this batch no longer match what was approved.");
    }
    await setBatchStatus(tx, batch, "executing", now);
    const ops = await tx.query<{ id: string }>(
      `update payment_operations set state = 'queued', updated_at = $3
        where org_id = $1 and batch_id = $2 and state = 'planned' returning id`,
      [input.orgId, input.batchId, now.toISOString()],
    );
    const spacing = input.spacingMs ?? DEFAULT_SPACING_MS;
    for (const [i, op] of ops.entries()) {
      await enqueue(tx, {
        type: "operation.execute", orgId: input.orgId, payload: { operationId: op.id },
        runAt: new Date(now.getTime() + i * spacing), dedupeKey: `operation.execute:${op.id}`,
      }, now);
    }
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.started", entityType: "batch",
      entityId: batch.id, data: { operations: ops.length, totalsHash: hash }, at: now,
    });
    return { queued: ops.length };
  });
}

export async function pauseBatch(
  tx: Queryable,
  input: { orgId: string; batchId: string; reason: string; actor: { kind: "user"; userId: string } | { kind: "system" }; now: Date },
): Promise<boolean> {
  const batch = await lockBatch(tx, input.orgId, input.batchId);
  if (batch.status !== "executing") return false;
  await setBatchStatus(tx, batch, "paused", input.now, { pausedReason: input.reason });
  await audit(tx, {
    orgId: input.orgId, actor: input.actor, action: "batch.paused", entityType: "batch", entityId: batch.id,
    data: { reason: input.reason }, at: input.now,
  });
  return true;
}

/** Resumes a paused batch. Operations waiting on the merchant (for example after adding funds) go round again. */
export async function resumeBatch(deps: Deps, input: { orgId: string; batchId: string; userId: string }): Promise<{ queued: number }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    await setBatchStatus(tx, batch, "executing", now);
    const ops = await tx.query<{ id: string }>(
      `update payment_operations set state = 'queued', next_attempt_at = null, failure_code = null, failure_message = null, updated_at = $3
        where org_id = $1 and batch_id = $2 and state in ('queued', 'failed_retryable') returning id`,
      [input.orgId, input.batchId, now.toISOString()],
    );
    for (const [i, op] of ops.entries()) {
      await enqueue(tx, {
        type: "operation.execute", orgId: input.orgId, payload: { operationId: op.id },
        runAt: new Date(now.getTime() + i * DEFAULT_SPACING_MS), dedupeKey: `operation.execute:${op.id}`,
      }, now);
    }
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.resumed", entityType: "batch",
      entityId: batch.id, data: { operations: ops.length }, at: now,
    });
    return { queued: ops.length };
  });
}

/**
 * Cancels what has not been sent. Operations already with PayPal, or whose
 * outcome is unknown, are NOT cancelled: they are followed to their end.
 */
export async function cancelBatch(deps: Deps, input: { orgId: string; batchId: string; userId: string }): Promise<{ cancelled: number; stillLive: number }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    const cancelled = await tx.query<{ id: string }>(
      `update payment_operations set state = 'cancelled', updated_at = $3, completed_at = $3
        where org_id = $1 and batch_id = $2 and state in ('planned', 'queued', 'failed_retryable') returning id`,
      [input.orgId, input.batchId, now.toISOString()],
    );
    const [live] = await tx.query<{ n: number }>(
      "select count(*)::int as n from payment_operations where org_id = $1 and batch_id = $2 and state in ('submitting','unknown','pending_provider')",
      [input.orgId, input.batchId],
    );
    await setBatchStatus(tx, batch, "cancelled", now);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.cancelled", entityType: "batch",
      entityId: batch.id, data: { cancelled: cancelled.length, stillLive: live?.n ?? 0 }, at: now,
    });
    return { cancelled: cancelled.length, stillLive: live?.n ?? 0 };
  });
}

/** Marks a batch finished once none of its operations can still change. Call after any operation settles. */
export async function finishBatchIfDone(tx: Queryable, orgId: string, batchId: string, now: Date): Promise<void> {
  const [counts] = await tx.query<{ open: number; failed: number }>(
    `select count(*) filter (where state not in ('succeeded','failed_final','cancelled'))::int as open,
            count(*) filter (where state = 'failed_final')::int as failed
       from payment_operations where org_id = $1 and batch_id = $2`,
    [orgId, batchId],
  );
  if (!counts || counts.open > 0) return;
  const batch = await lockBatch(tx, orgId, batchId);
  if (batch.status !== "executing" && batch.status !== "paused") return;
  const to: BatchStatus = counts.failed > 0 ? "completed_with_failures" : "completed";
  await setBatchStatus(tx, batch, to, now);
  await audit(tx, {
    orgId, actor: { kind: "system" }, action: "batch.finished", entityType: "batch", entityId: batchId,
    data: { status: to, failed: counts.failed }, at: now,
  });
}
