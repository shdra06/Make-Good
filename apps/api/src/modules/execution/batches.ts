// Batches: the controlled path from "these customers are owed money" to
// "pay them".  preview ─▶ create ─▶ submit ─▶ approve ─▶ start
//
// Nothing here calls PayPal. Starting a batch only queues operations; the
// executor (executor.ts) carries them out.
//
// What a person approves is the batch's manifest (manifests.ts): the exact,
// unchangeable list of payments. If anything that list rests on changes
// before the batch starts, the approval is withdrawn and the batch goes back
// to draft, where it can be revised into a new manifest version.

import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import { enqueue } from "../../platform/jobs/queue.ts";
import { checkManifest, currentManifest, describeRule, writeManifest, type Drift } from "./manifests.ts";
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

/** Refunds go back to the original payment. A payout is a new payment to a person, so it is approved separately. */
export type BatchKind = "refund" | "payout";

export type PlannedItem = {
  candidateId: string;
  calculationId: string;
  kind: BatchKind;
  captureId: string | null;
  recipientType: "EMAIL" | "PAYPAL_ID" | null;
  recipient: string | null;
  currency: string;
  amountMinor: number;
  classification: string;
  customerEmail: string | null;
  customerName: string | null;
  subjectKey: string;
  orderId: string | null;
  orderNumber: string | null;
  orderLineId: string | null;
  sku: string | null;
  lineTitle: string | null;
  affectedQuantity: number;
  paymentIdentity: string;
  eligibility: string;
  decision: string;
  /** Null when the records alone made the customer payable. */
  decidedByName: string | null;
  decisionBasis: string | null;
  decisionNote: string | null;
  entitlementMinor: number;
  alreadyRefundedMinor: number;
  paymentTransactionId: string | null;
  captureGrossMinor: number | null;
  captureRefundedMinor: number | null;
  /** Why the customer is owed this, in words. Stored with the payment. */
  reason: string;
};

/** A customer of the incident that a payment list leaves out, with the reason. */
export type HeldItem = {
  candidateId: string;
  why: string;
  orderNumber: string | null;
  customerName: string | null;
  customerEmail: string | null;
  paymentIdentity: string;
  eligibility: string;
  decision: string;
  status: string;
  currency: string | null;
  /** What the rule would pay, if the record became payable. Null when it cannot be worked out. */
  wouldPayMinor: number | null;
};

export type BatchTotals = {
  count: number;
  byCurrency: Record<string, { count: number; amountMinor: number }>;
  byKind: Record<string, number>;
  byClassification: Record<string, number>;
};

export type BatchPreview = {
  kind: BatchKind;
  items: PlannedItem[];
  totals: BatchTotals;
  totalsHash: string;
  /** Affected customers this batch does not pay, counted by reason. */
  notIncluded: Record<string, number>;
  /** The same customers, one by one. */
  held: HeldItem[];
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

/** A fingerprint of exactly what will be paid to whom. */
export function totalsHash(items: readonly Pick<PlannedItem, "candidateId" | "kind" | "captureId" | "recipient" | "currency" | "amountMinor">[]): string {
  const lines = items
    .map((i) => [i.candidateId, i.kind, i.captureId ?? "", i.recipient ?? "", i.currency, i.amountMinor].join("|"))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Why a record is not in a payment list. The codes are part of the API.
 *
 *   waiting_for_confirmation      a person has not decided yet
 *   payment_not_reconciled        it is not settled which PayPal payment paid for the order
 *   eligibility_not_confirmed     not proven by the records, and no person has confirmed it
 *   paid_under_another_incident   the same order line was already compensated in another incident
 *   payment_in_another_batch      another batch is already refunding the same PayPal payment
 *   second_refund_on_same_payment one refund per PayPal payment per batch; the next goes in a later batch
 *   payout_needs_its_own_approval a payout is a new payment and is approved in a batch of its own
 */
export async function previewBatch(
  q: Queryable,
  orgId: string,
  incidentId: string,
  options: { kind?: BatchKind; forBatchId?: string } = {},
): Promise<BatchPreview> {
  const kind = options.kind ?? "refund";
  const [incident] = await q.query<{ title: string; compensation: unknown }>(
    `select i.title, (select r.compensation from incident_rule_versions r
                       where r.org_id = i.org_id and r.incident_id = i.id order by r.version desc limit 1) as compensation
       from incidents i where i.org_id = $1 and i.id = $2`,
    [orgId, incidentId],
  );
  const reasonBase = incident ? `${incident.title}: ${describeRule(incident.compensation)}` : "";
  const rows = await q.query<{
    candidate_id: string; status: string; classification: string; customer_email: string | null; customer_name: string | null;
    subject_key: string; order_id: string | null; order_line_id: string | null; affected_quantity: number;
    payment_identity: string; eligibility: string; decision: string; decided_by: string | null; decided_by_name: string | null;
    decision_basis: string | null; decision_note: string | null;
    calculation_id: string | null; route: string | null; payable_minor: number | null; entitlement_minor: number | null;
    already_refunded_minor: number | null; currency: string | null;
    steps: { recipient?: { type: "EMAIL" | "PAYPAL_ID"; value: string } | null } | null;
    capture_id: string | null; payment_transaction_id: string | null; gross_minor: number | null; refunded_minor: number | null;
    order_number: string | null; sku: string | null; line_title: string | null;
    has_live_operation: boolean; paid_elsewhere: string | null; capture_busy: boolean;
  }>(
    `select c.id as candidate_id, c.status, c.classification, c.customer_email, c.customer_name, c.subject_key,
            c.order_id, c.order_line_id, c.affected_quantity, c.payment_identity, c.eligibility, c.decision,
            c.decided_by, u.name as decided_by_name, c.decision_basis, c.decision_note,
            k.id as calculation_id, k.route, k.payable_minor, k.entitlement_minor, k.already_refunded_minor,
            trim(k.currency) as currency, k.steps,
            p.transaction_id as capture_id, p.id as payment_transaction_id, p.gross_minor, p.refunded_minor,
            o.order_number, l.sku, l.title as line_title,
            exists (select 1 from payment_operations op
                     where op.org_id = c.org_id and op.candidate_id = c.id
                       and op.state in ('planned','queued','submitting','unknown','pending_provider','succeeded','failed_retryable')
                       and (op.batch_id is distinct from $3::uuid or op.state <> 'planned')) as has_live_operation,
            -- the same order line, already compensated under a different incident
            (select i2.title from payment_operations op
               join incidents i2 on i2.org_id = op.org_id and i2.id = op.incident_id
              where op.org_id = c.org_id and c.order_line_id is not null and op.order_line_id = c.order_line_id
                and op.incident_id <> c.incident_id and op.state in ('succeeded', 'pending_provider', 'unknown', 'submitting', 'queued')
              limit 1) as paid_elsewhere,
            -- another batch already holds a refund on the same PayPal payment
            exists (select 1 from payment_operations op
                     where op.org_id = c.org_id and op.kind = 'refund' and op.capture_id = p.transaction_id
                       and op.candidate_id <> c.id
                       and op.state in ('planned','queued','submitting','unknown','pending_provider','failed_retryable')
                       and op.batch_id is distinct from $3::uuid) as capture_busy
       from candidates c
       left join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
       left join payment_transactions p on p.org_id = c.org_id and p.id = c.payment_transaction_id
       left join orders o on o.org_id = c.org_id and o.id = c.order_id
       left join order_lines l on l.org_id = c.org_id and l.id = c.order_line_id
       left join users u on u.id = c.decided_by
      where c.org_id = $1 and c.incident_id = $2 and c.status <> 'cleared'
      order by c.created_at, c.id`,
    [orgId, incidentId, options.forBatchId ?? null],
  );
  const items: PlannedItem[] = [];
  const held: HeldItem[] = [];
  const notIncluded: Record<string, number> = {};
  const capturesUsed = new Set<string>();

  for (const r of rows) {
    const skip = (why: string) => {
      notIncluded[why] = (notIncluded[why] ?? 0) + 1;
      held.push({
        candidateId: r.candidate_id, why, orderNumber: r.order_number, customerName: r.customer_name, customerEmail: r.customer_email,
        paymentIdentity: r.payment_identity, eligibility: r.eligibility, decision: r.decision, status: r.status,
        currency: r.currency, wouldPayMinor: r.payable_minor,
      });
    };
    const common = () => ({
      candidateId: r.candidate_id, calculationId: r.calculation_id!, currency: r.currency!, amountMinor: r.payable_minor!,
      classification: r.classification, customerEmail: r.customer_email, customerName: r.customer_name, subjectKey: r.subject_key,
      orderId: r.order_id, orderNumber: r.order_number, orderLineId: r.order_line_id, sku: r.sku, lineTitle: r.line_title,
      affectedQuantity: r.affected_quantity, paymentIdentity: r.payment_identity, eligibility: r.eligibility, decision: r.decision,
      decidedByName: r.decided_by ? r.decided_by_name ?? "a member of staff" : null, decisionBasis: r.decision_basis, decisionNote: r.decision_note,
      entitlementMinor: r.entitlement_minor ?? 0, alreadyRefundedMinor: r.already_refunded_minor ?? 0,
      paymentTransactionId: r.payment_transaction_id, captureGrossMinor: r.gross_minor, captureRefundedMinor: r.refunded_minor,
      reason: reasonBase,
    });
    // A category on a screen is never enough to pay someone. These checks are made again, from the stored
    // answers, every time a payment list is built.
    const unconfirmed = r.eligibility !== "proven" && r.decided_by === null;

    if (r.status === "excluded") skip("excluded");
    else if (r.status === "declined") skip("declined");
    else if (r.status === "proposed") skip("waiting_for_confirmation");
    else if (r.has_live_operation) skip("already_in_a_batch_or_paid");
    else if (!r.calculation_id || r.route === "none" || !r.payable_minor) skip("nothing_to_pay");
    else if (r.route === "manual") skip("needs_manual_handling");
    else if (unconfirmed) skip("eligibility_not_confirmed");
    else if (r.paid_elsewhere && r.decision_basis !== "cross_incident_reviewed") skip("paid_under_another_incident");
    else if (r.route === "refund_original") {
      if (!r.capture_id) skip("needs_manual_handling");
      else if (r.payment_identity !== "verified") skip("payment_not_reconciled");
      else if (kind !== "refund") skip("refund_goes_in_a_refund_batch");
      else if (r.capture_busy) skip("payment_in_another_batch");
      else if (capturesUsed.has(r.capture_id)) skip("second_refund_on_same_payment");
      else {
        capturesUsed.add(r.capture_id);
        items.push({ ...common(), kind: "refund", captureId: r.capture_id, recipientType: null, recipient: null });
      }
    } else {
      const recipient = r.steps?.recipient;
      if (!recipient) skip("needs_manual_handling");
      else if (r.payment_identity !== "verified" && r.payment_identity !== "not_paypal") skip("payment_not_reconciled");
      else if (kind !== "payout") skip("payout_needs_its_own_approval");
      else items.push({ ...common(), kind: "payout", captureId: null, recipientType: recipient.type, recipient: recipient.value });
    }
  }
  return { kind, items, totals: totalsOf(items), totalsHash: totalsHash(items), notIncluded, held };
}

type BatchRow = {
  id: string; org_id: string; incident_id: string; rule_version_id: string; status: BatchStatus; kind: BatchKind;
  totals: BatchTotals; totals_hash: string | null; created_by: string | null; approved_manifest_id: string | null;
};

async function lockBatch(tx: Queryable, orgId: string, batchId: string): Promise<BatchRow> {
  const rows = await tx.query<BatchRow>(
    `select id, org_id, incident_id, rule_version_id, status, kind, totals, totals_hash, created_by, approved_manifest_id
       from batches where org_id = $1 and id = $2 for update`,
    [orgId, batchId],
  );
  if (!rows[0]) throw new NotFoundError("Batch");
  return rows[0];
}

async function currentItems(tx: Queryable, orgId: string, batchId: string) {
  return tx.query<{ candidateId: string; kind: BatchKind; captureId: string | null; recipient: string | null; currency: string; amountMinor: number }>(
    `select candidate_id as "candidateId", kind, capture_id as "captureId", recipient, trim(currency) as currency, amount_minor as "amountMinor"
       from payment_operations where org_id = $1 and batch_id = $2 and state <> 'cancelled'`,
    [orgId, batchId],
  );
}

/** Writes the planned operations for a preview and returns the items with their operation IDs. */
async function planOperations(
  tx: Queryable,
  input: { orgId: string; batchId: string; incidentId: string; ruleVersionId: string; connectionId: string; items: PlannedItem[]; now: Date },
): Promise<Array<PlannedItem & { operationId: string; requestId: string }>> {
  const existing = new Map(
    (await tx.query<{ id: string; candidate_id: string; state: string; idempotency_key: string }>(
      "select id, candidate_id, state, idempotency_key from payment_operations where org_id = $1 and batch_id = $2",
      [input.orgId, input.batchId],
    )).map((r) => [r.candidate_id, r]),
  );
  const out: Array<PlannedItem & { operationId: string; requestId: string }> = [];
  for (const item of input.items) {
    const ledger = [
      input.incidentId, item.orderId, item.orderLineId, input.ruleVersionId, item.reason, item.captureGrossMinor, item.captureRefundedMinor,
    ];
    const prior = existing.get(item.candidateId);
    if (prior?.state === "planned") {
      // A revision: the operation was never sent, so it keeps its identity and takes the new figures.
      await tx.query(
        `update payment_operations
            set calculation_id = $3, kind = $4, capture_id = $5, recipient_type = $6, recipient = $7, currency = $8, amount_minor = $9,
                incident_id = $10, order_id = $11, order_line_id = $12, rule_version_id = $13, reason = $14,
                capture_gross_minor = $15, capture_refunded_before_minor = $16, updated_at = $17
          where org_id = $1 and id = $2`,
        [input.orgId, prior.id, item.calculationId, item.kind, item.captureId, item.recipientType, item.recipient, item.currency,
         item.amountMinor, ...ledger, input.now.toISOString()],
      );
      existing.delete(item.candidateId);
      out.push({ ...item, operationId: prior.id, requestId: prior.idempotency_key });
      continue;
    }
    if (prior) continue; // removed from this batch earlier; it can go into a new batch
    const [op] = await tx.query<{ id: string }>("select gen_random_uuid() as id");
    // The key PayPal sees. Fixed for the life of the operation, so a retry can never pay twice.
    const requestId = `mg-${op!.id}`;
    await tx.query(
      `insert into payment_operations
         (id, org_id, batch_id, candidate_id, calculation_id, kind, paypal_connection_id, capture_id, recipient_type,
          recipient, currency, amount_minor, state, idempotency_key, incident_id, order_id, order_line_id, rule_version_id,
          reason, capture_gross_minor, capture_refunded_before_minor, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned',$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
      [
        op!.id, input.orgId, input.batchId, item.candidateId, item.calculationId, item.kind, input.connectionId, item.captureId,
        item.recipientType, item.recipient, item.currency, item.amountMinor, requestId, ...ledger, input.now.toISOString(),
      ],
    );
    out.push({ ...item, operationId: op!.id, requestId });
  }
  // Planned operations the new list no longer contains are withdrawn. They were never sent.
  for (const stale of existing.values()) {
    if (stale.state !== "planned") continue;
    await tx.query(
      `update payment_operations set state = 'cancelled', failure_code = 'REMOVED_ON_REVISION',
              failure_message = 'Removed when the payment list was revised.', updated_at = $3, completed_at = $3
        where org_id = $1 and id = $2`,
      [input.orgId, stale.id, input.now.toISOString()],
    );
  }
  return out;
}

export type ManifestRef = { id: string; version: number; contentHash: string };

export async function createBatch(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string; name: string; kind?: BatchKind },
): Promise<{ id: string; preview: BatchPreview; manifest: ManifestRef }> {
  const now = deps.clock.now();
  const kind = input.kind ?? "refund";
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
    const preview = await previewBatch(tx, input.orgId, input.incidentId, { kind });
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
      `insert into batches (org_id, incident_id, rule_version_id, name, kind, totals, totals_hash, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) returning id`,
      [input.orgId, input.incidentId, rule[0].id, input.name, kind, json(preview.totals), preview.totalsHash, input.userId, now.toISOString()],
    );
    const planned = await planOperations(tx, {
      orgId: input.orgId, batchId: batch!.id, incidentId: input.incidentId, ruleVersionId: rule[0].id,
      connectionId: connection[0].id, items: preview.items, now,
    });
    const manifest = await writeManifest(tx, {
      orgId: input.orgId, batchId: batch!.id, userId: input.userId, now, items: planned, held: preview.held, totals: preview.totals,
    });
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.created", entityType: "batch",
      entityId: batch!.id,
      data: { incidentId: input.incidentId, kind, totals: preview.totals, totalsHash: preview.totalsHash, manifestVersion: manifest.version, manifestHash: manifest.contentHash },
      at: now,
    });
    return { id: batch!.id, preview, manifest };
  });
}

/**
 * Builds the next version of a draft batch's payment list from the records
 * as they are now. Used after an approval was withdrawn. Earlier versions
 * are kept, marked as no longer in force.
 */
export async function reviseBatch(
  deps: Deps,
  input: { orgId: string; batchId: string; userId: string },
): Promise<{ preview: BatchPreview; manifest: ManifestRef }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    if (batch.status !== "draft") {
      throw new ConflictError("NOT_A_DRAFT", `This batch is ${batch.status}. Only a draft can be revised.`);
    }
    const rule = await tx.query<{ id: string }>(
      "select id from incident_rule_versions where org_id = $1 and incident_id = $2 order by version desc limit 1",
      [input.orgId, batch.incident_id],
    );
    const stale = await tx.query<{ n: number }>(
      `select count(*)::int as n from candidates
        where org_id = $1 and incident_id = $2 and status = 'confirmed' and rule_version_id <> $3`,
      [input.orgId, batch.incident_id, rule[0]!.id],
    );
    if ((stale[0]?.n ?? 0) > 0) {
      throw new ConflictError("RULES_CHANGED", "The rules changed after these customers were matched. Run the match again first.");
    }
    const [connection] = await tx.query<{ id: string }>(
      "select id from paypal_connections where org_id = $1 and status = 'connected' order by (environment = 'live') desc, created_at limit 1",
      [input.orgId],
    );
    if (!connection) throw new ConflictError("NO_PAYPAL_CONNECTION", "Connect a PayPal account first.");
    const preview = await previewBatch(tx, input.orgId, batch.incident_id, { kind: batch.kind, forBatchId: batch.id });
    if (preview.items.length === 0) {
      throw new ConflictError("NOTHING_TO_PAY", "Nobody in this batch can be paid any more. Cancel the batch.", preview.notIncluded);
    }
    const planned = await planOperations(tx, {
      orgId: input.orgId, batchId: batch.id, incidentId: batch.incident_id, ruleVersionId: rule[0]!.id,
      connectionId: connection.id, items: preview.items, now,
    });
    // The totals describe what was actually planned (an item removed from this batch earlier stays out).
    const totals = totalsOf(planned);
    const hash = totalsHash(planned);
    await tx.query("update batches set rule_version_id = $3, totals = $4::jsonb, totals_hash = $5 where org_id = $1 and id = $2", [
      input.orgId, batch.id, rule[0]!.id, json(totals), hash,
    ]);
    const manifest = await writeManifest(tx, {
      orgId: input.orgId, batchId: batch.id, userId: input.userId, now, items: planned, held: preview.held, totals,
    });
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.revised", entityType: "batch",
      entityId: batch.id, data: { totals, totalsHash: hash, manifestVersion: manifest.version, manifestHash: manifest.contentHash }, at: now,
    });
    return { preview: { ...preview, items: planned, totals, totalsHash: hash }, manifest };
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

/**
 * Refuses to go on if the batch's payment list is no longer true. When the
 * records changed, the approval has already been withdrawn (and that is
 * committed) by the time this throws.
 */
async function requireValidManifest(deps: Deps, orgId: string, batchId: string, userId: string, tampered: string): Promise<ManifestRef> {
  const check = await checkManifest(deps, { orgId, batchId, actor: { kind: "user", userId } });
  if (check.ok) return check.manifest;
  if (check.reason === "operations_differ") throw new ConflictError("BATCH_CHANGED", tampered, { changes: check.drifts });
  if (check.reason === "no_current_manifest") {
    throw new ConflictError("NO_CURRENT_PAYMENT_LIST", "This batch has no payment list in force. Revise the batch to build one, then send it for approval again.");
  }
  throw new ConflictError(
    "APPROVAL_INVALIDATED",
    "What this batch would pay has changed since its payment list was built, so the list and any approval of it have been withdrawn. Revise the batch and send it for approval again.",
    { changes: summarise(check.drifts) },
  );
}

const summarise = (drifts: Drift[]) => drifts.slice(0, 25);

export async function submitBatch(deps: Deps, input: { orgId: string; batchId: string; userId: string }): Promise<void> {
  const now = deps.clock.now();
  const manifest = await requireValidManifest(deps, input.orgId, input.batchId, input.userId, "The contents of this batch changed after it was created. Create it again.");
  await deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    await setBatchStatus(tx, batch, "pending_approval", now);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "batch.submitted", entityType: "batch",
      entityId: batch.id, data: { totalsHash: batch.totals_hash, manifestVersion: manifest.version, manifestHash: manifest.contentHash }, at: now,
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
): Promise<{ status: BatchStatus; approvals: number; needed: number; manifestVersion: number }> {
  const now = deps.clock.now();
  if (!APPROVER_ROLES.includes(input.role)) throw new ForbiddenError("Your role cannot approve payments.");
  // The cheap refusals come first, so that a person who may not approve cannot trigger anything.
  const [pre] = await deps.db.query<{ status: BatchStatus; created_by: string | null; settings: { approval?: unknown } }>(
    `select b.status, b.created_by, o.settings from batches b join organisations o on o.id = b.org_id where b.org_id = $1 and b.id = $2`,
    [input.orgId, input.batchId],
  );
  if (!pre) throw new NotFoundError("Batch");
  if (pre.status !== "pending_approval") {
    throw new ConflictError("NOT_AWAITING_APPROVAL", `This batch is ${pre.status}, not waiting for approval.`);
  }
  if (input.decision === "approve" && ApprovalPolicy.parse(pre.settings?.approval ?? {}).dualControl && pre.created_by === input.userId) {
    throw new ForbiddenError("This organisation requires a second person: the creator of a batch cannot approve it.");
  }
  if (input.decision === "approve") {
    await requireValidManifest(deps, input.orgId, input.batchId, input.userId, "The contents of this batch changed after it was submitted. Create it again.");
  }

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
    const manifest = await currentManifest(tx, input.orgId, input.batchId);
    if (!manifest) {
      throw new ConflictError("NO_CURRENT_PAYMENT_LIST", "This batch has no payment list in force. Revise the batch first.");
    }
    // The approval is tied to what is in the batch right now.
    const hash = totalsHash(await currentItems(tx, input.orgId, input.batchId));
    if (hash !== batch.totals_hash) {
      throw new ConflictError("BATCH_CHANGED", "The contents of this batch changed after it was submitted. Create it again.");
    }
    await tx.query(
      `insert into batch_approvals (org_id, batch_id, user_id, decision, comment, totals_hash, manifest_id, manifest_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (org_id, batch_id, user_id) do update set decision = excluded.decision, comment = excluded.comment,
         totals_hash = excluded.totals_hash, manifest_id = excluded.manifest_id, manifest_hash = excluded.manifest_hash,
         created_at = excluded.created_at`,
      [input.orgId, input.batchId, input.userId, input.decision, input.comment ?? null, hash, manifest.id, manifest.content_hash, now.toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `batch.${input.decision}`,
      entityType: "batch", entityId: batch.id,
      data: { totalsHash: hash, manifestId: manifest.id, manifestVersion: manifest.version, manifestHash: manifest.content_hash, comment: input.comment ?? null },
      at: now,
    });
    const needed = approvalsNeeded(policy, batch.totals, org!.default_currency);
    if (input.decision === "reject") {
      await setBatchStatus(tx, batch, "rejected", now);
      await tx.query("update payment_operations set state = 'cancelled', updated_at = $3, completed_at = $3 where org_id = $1 and batch_id = $2 and state = 'planned'", [
        input.orgId, input.batchId, now.toISOString(),
      ]);
      return { status: batch.status, approvals: 0, needed, manifestVersion: manifest.version };
    }
    // Only approvals of this exact version of the list count.
    const [count] = await tx.query<{ n: number }>(
      "select count(*)::int as n from batch_approvals where org_id = $1 and batch_id = $2 and decision = 'approve' and manifest_id = $3 and manifest_hash = $4",
      [input.orgId, input.batchId, manifest.id, manifest.content_hash],
    );
    if ((count?.n ?? 0) >= needed) {
      await setBatchStatus(tx, batch, "approved", now);
      await tx.query("update batches set approved_manifest_id = $3 where org_id = $1 and id = $2", [input.orgId, input.batchId, manifest.id]);
    }
    return { status: batch.status, approvals: count?.n ?? 0, needed, manifestVersion: manifest.version };
  });
}

/** How far apart operations are released, so we stay under the provider's rate limit. */
const DEFAULT_SPACING_MS = 250;

export async function startBatch(
  deps: Deps,
  input: { orgId: string; batchId: string; userId: string; spacingMs?: number },
): Promise<{ queued: number }> {
  const now = deps.clock.now();
  const [pre] = await deps.db.query<{ status: BatchStatus }>("select status from batches where org_id = $1 and id = $2", [input.orgId, input.batchId]);
  if (!pre) throw new NotFoundError("Batch");
  assertBatchTransition(pre.status, "executing");
  await requireValidManifest(deps, input.orgId, input.batchId, input.userId, "The contents of this batch no longer match what was approved.");

  return deps.db.tx(async (tx) => {
    const batch = await lockBatch(tx, input.orgId, input.batchId);
    const manifest = await currentManifest(tx, input.orgId, input.batchId);
    if (!manifest || batch.approved_manifest_id !== manifest.id) {
      throw new ConflictError("NOT_APPROVED", "The payment list in force for this batch has not been approved.");
    }
    const hash = totalsHash(await currentItems(tx, input.orgId, input.batchId));
    if (hash !== batch.totals_hash) {
      throw new ConflictError("BATCH_CHANGED", "The contents of this batch no longer match what was approved.");
    }
    await setBatchStatus(tx, batch, "executing", now);
    // Only operations listed on the approved manifest are released.
    const ops = await tx.query<{ id: string }>(
      `update payment_operations set state = 'queued', updated_at = $3
        where org_id = $1 and batch_id = $2 and state = 'planned' and manifest_id = $4 returning id`,
      [input.orgId, input.batchId, now.toISOString(), manifest.id],
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
      entityId: batch.id, data: { operations: ops.length, totalsHash: hash, manifestVersion: manifest.version, manifestHash: manifest.content_hash }, at: now,
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
            -- a payment the worker withheld because its approval no longer covered it counts as not done
            count(*) filter (where state = 'failed_final' or (state = 'cancelled' and failure_code = 'APPROVAL_NO_LONGER_COVERS'))::int as failed
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
