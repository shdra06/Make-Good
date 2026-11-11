// Read-only queries behind the screens. Every one takes orgId and filters by
// it. Lists are paged; nothing here loads a whole table.

import type { Queryable } from "../../platform/db/db.ts";
import { verifyAuditChain } from "../../platform/audit.ts";
import { DAY } from "../../platform/clock.ts";
import { maskEmail } from "../../platform/crypto.ts";
import { DISPOSITION_SQL, MAP_FROM } from "../recovery/map.ts";

export type Page = { limit: number; offset: number };
export const pageOf = (page: number | undefined, size: number | undefined): Page => {
  const limit = Math.min(200, Math.max(1, size ?? 50));
  return { limit, offset: (Math.max(1, page ?? 1) - 1) * limit };
};

export async function dashboard(q: Queryable, orgId: string, now: Date) {
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const [daily, volume, incidents, candidates, owed, batches, operations, detections, recent, connection, sync] = await Promise.all([
    q.query<{ day: string; payments: number; refunds: number }>(
      `select to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day,
              count(*) filter (where kind = 'payment')::int as payments,
              count(*) filter (where kind = 'refund')::int as refunds
         from payment_transactions where org_id = $1 and occurred_at >= $2 group by 1 order by 1`,
      [orgId, since],
    ),
    q.query<{ currency: string; kind: string; n: number; amount_minor: number }>(
      `select trim(currency) as currency, kind, count(*)::int as n, sum(gross_minor)::bigint as amount_minor
         from payment_transactions where org_id = $1 and occurred_at >= $2 and kind in ('payment', 'refund') group by 1, 2 order by 1, 2`,
      [orgId, since],
    ),
    q.query<{ status: string; n: number }>("select status, count(*)::int as n from incidents where org_id = $1 group by 1", [orgId]),
    q.query<{ status: string; classification: string; n: number }>(
      `select c.status, c.classification, count(*)::int as n from candidates c
         join incidents i on i.org_id = c.org_id and i.id = c.incident_id
        where c.org_id = $1 and i.status = 'active' group by 1, 2`,
      [orgId],
    ),
    q.query<{ currency: string; status: string; customers: number; amount_minor: number }>(
      `select trim(k.currency) as currency, c.status, count(*)::int as customers, sum(k.payable_minor)::bigint as amount_minor
         from candidates c
         join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
         join incidents i on i.org_id = c.org_id and i.id = c.incident_id
        where c.org_id = $1 and i.status = 'active' and c.status in ('proposed', 'confirmed') and k.payable_minor > 0
          and not exists (select 1 from payment_operations op where op.org_id = c.org_id and op.candidate_id = c.id and op.state = 'succeeded')
        group by 1, 2 order by 1`,
      [orgId],
    ),
    q.query<{ status: string; n: number }>("select status, count(*)::int as n from batches where org_id = $1 group by 1", [orgId]),
    q.query<{ state: string; currency: string; n: number; amount_minor: number }>(
      `select state, trim(currency) as currency, count(*)::int as n, sum(amount_minor)::bigint as amount_minor
         from payment_operations where org_id = $1 group by 1, 2`,
      [orgId],
    ),
    q.query<{ severity: string; n: number }>("select severity, count(*)::int as n from detections where org_id = $1 and status = 'open' group by 1", [orgId]),
    q.query<{ id: number; action: string; entity_type: string; entity_id: string | null; actor_kind: string; created_at: Date }>(
      "select id, action, entity_type, entity_id, actor_kind, created_at from audit_events where org_id = $1 order by id desc limit 12",
      [orgId],
    ),
    q.query<{ environment: string; status: string; mode: string }>(
      "select environment, status, mode from paypal_connections where org_id = $1 and status <> 'revoked' order by created_at",
      [orgId],
    ),
    q.query<{ source: string; status: string; finished_at: Date | null; stats: unknown }>(
      "select source, status, finished_at, stats from sync_runs where org_id = $1 order by started_at desc limit 1",
      [orgId],
    ),
  ]);
  return {
    asOf: now.toISOString(), since, daily, volume, incidents, candidates, owed, batches, operations, detections,
    recentActivity: recent, connections: connection, lastSync: sync[0] ?? null,
  };
}

export async function listIncidents(q: Queryable, orgId: string) {
  return q.query(
    `select i.id, i.kind, i.title, i.status, i.claims_open, i.public_slug, i.created_at,
            (select max(version) from incident_rule_versions r where r.org_id = i.org_id and r.incident_id = i.id) as rule_version,
            (select count(*)::int from candidates c where c.org_id = i.org_id and c.incident_id = i.id and c.status = 'confirmed') as confirmed,
            (select count(*)::int from candidates c where c.org_id = i.org_id and c.incident_id = i.id and c.status = 'proposed') as awaiting,
            (select count(*)::int from payment_operations op join batches b on b.org_id = op.org_id and b.id = op.batch_id
              where op.org_id = i.org_id and b.incident_id = i.id and op.state = 'succeeded') as paid,
            (select count(*)::int from claims cl where cl.org_id = i.org_id and cl.incident_id = i.id) as claims
       from incidents i where i.org_id = $1 order by i.created_at desc`,
    [orgId],
  );
}

export async function incidentDetail(q: Queryable, orgId: string, incidentId: string) {
  const [incident] = await q.query(
    `select id, kind, title, description, status, claims_open, public_slug, claim_instructions, created_at, updated_at, closed_at
       from incidents where org_id = $1 and id = $2`,
    [orgId, incidentId],
  );
  if (!incident) return null;
  const [rules, summary, owed, lastRun, batches] = await Promise.all([
    q.query("select id, version, scope, compensation, note, created_at from incident_rule_versions where org_id = $1 and incident_id = $2 order by version desc", [orgId, incidentId]),
    q.query<{ classification: string; status: string; n: number; units: number }>(
      `select classification, status, count(*)::int as n, sum(affected_quantity)::int as units
         from candidates where org_id = $1 and incident_id = $2 group by 1, 2`,
      [orgId, incidentId],
    ),
    q.query<{ currency: string; status: string; route: string; customers: number; amount_minor: number }>(
      `select trim(k.currency) as currency, c.status, k.route, count(*)::int as customers, sum(k.payable_minor)::bigint as amount_minor
         from candidates c join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
        where c.org_id = $1 and c.incident_id = $2 and c.status in ('proposed', 'confirmed') group by 1, 2, 3`,
      [orgId, incidentId],
    ),
    q.query("select id, rule_version_id, stats, finished_at from match_runs where org_id = $1 and incident_id = $2 order by started_at desc limit 1", [orgId, incidentId]),
    q.query("select id, name, status, totals, created_at from batches where org_id = $1 and incident_id = $2 order by created_at desc", [orgId, incidentId]),
  ]);
  return { incident, rules, summary, owed, lastRun: lastRun[0] ?? null, batches };
}

export async function listCandidates(
  q: Queryable,
  orgId: string,
  incidentId: string,
  filter: {
    classification?: string; status?: string; search?: string; disposition?: string; decision?: string;
    paymentIdentity?: string; eligibility?: string; includeCleared?: boolean;
  },
  page: Page,
) {
  const params: unknown[] = [orgId, incidentId];
  let where = "";
  const equal = (column: string, value: string | undefined) => {
    if (!value) return;
    params.push(value);
    where += ` and ${column} = $${params.length}`;
  };
  equal("c.classification", filter.classification);
  equal("c.status", filter.status);
  equal("c.decision", filter.decision);
  equal("c.payment_identity", filter.paymentIdentity);
  equal("c.eligibility", filter.eligibility);
  equal(`(${DISPOSITION_SQL})`, filter.disposition);
  // Buyers shown not to be affected are part of the picture only when asked for.
  if (!filter.includeCleared && !filter.status && !filter.disposition && !filter.eligibility) where += " and c.status <> 'cleared'";
  if (filter.search) {
    params.push(`%${filter.search.toLowerCase()}%`);
    where += ` and (lower(coalesce(c.customer_email, '')) like $${params.length} or lower(coalesce(c.customer_name, '')) like $${params.length} or lower(coalesce(o.order_number, '')) like $${params.length})`;
  }
  const [total] = await q.query<{ n: number }>(`select count(*)::int as n ${MAP_FROM} where c.org_id = $1 and c.incident_id = $2 ${where}`, params);
  const rows = await q.query(
    `select c.id, c.subject_key, c.classification, c.status, c.needs_confirmation, c.exclusion_code, c.recommended_action,
            c.payment_identity, c.eligibility, c.decision, ${DISPOSITION_SQL} as disposition,
            c.affected_quantity, c.customer_email, c.customer_name, c.reasons, c.missing, c.facts,
            c.decision_basis, c.decision_note, u.name as decided_by, c.decided_at,
            o.order_number, o.placed_at, l.sku, l.title as line_title, l.quantity as line_quantity,
            p.transaction_id, p.payer_country, p.gross_minor, p.refunded_minor, p.dispute_state, p.environment,
            k.payable_minor, k.entitlement_minor, trim(k.currency) as currency, k.route, k.route_reason,
            lo.state as payment_state, lo.failure_code, lo.failure_message, lo.provider_refund_id, lo.provider_payout_item_id,
            lo.provider_status, lo.amount_minor as payment_amount_minor, lo.batch_id, lo.id as operation_id, lo.attempts,
            (select jsonb_object_agg(kind, n) from (
               select e.kind, count(*)::int as n from match_evidence e where e.org_id = c.org_id and e.candidate_id = c.id group by e.kind) x) as evidence_kinds
       ${MAP_FROM}
      where c.org_id = $1 and c.incident_id = $2 ${where}
      order by array_position(array['ready','in_a_batch','in_progress','outcome_unknown','payment_failed','needs_eligibility_evidence','reconcile_payment',
                                    'investigate','pay_outside_paypal','needs_manual_handling','on_hold','paid','excluded','declined','nothing_to_pay','not_affected'],
                              ${DISPOSITION_SQL}), o.placed_at nulls last, c.id
      limit ${page.limit} offset ${page.offset}`,
    params,
  );
  return { total: total?.n ?? 0, rows };
}

export async function candidateDetail(q: Queryable, orgId: string, candidateId: string) {
  const [candidate] = await q.query<{ order_id: string | null; payment_transaction_id: string | null } & Record<string, unknown>>(
    `select c.*, ${DISPOSITION_SQL} as disposition, u.name as decided_by_name
       ${MAP_FROM} where c.org_id = $1 and c.id = $2`,
    [orgId, candidateId],
  );
  if (!candidate) return null;
  const [evidence, calculation, order, lines, payment, operations, paymentOptions, fulfilments] = await Promise.all([
    q.query(
      `select source, record_id, fact, strength, dimension, kind, created_at from match_evidence
        where org_id = $1 and candidate_id = $2
        order by array_position(array['payment', 'eligibility', 'state'], dimension), created_at, id`,
      [orgId, candidateId],
    ),
    q.query(
      `select id, trim(currency) as currency, entitlement_minor, already_refunded_minor, payable_minor, route, route_reason, steps, created_at
         from compensation_calculations where org_id = $1 and candidate_id = $2 and is_current`,
      [orgId, candidateId],
    ),
    candidate.order_id
      ? q.query("select id, order_number, placed_at, trim(currency) as currency, total_minor, payment_method, payment_reference, status, customer_name, customer_email from orders where org_id = $1 and id = $2", [orgId, candidate.order_id])
      : Promise.resolve([]),
    candidate.order_id
      ? q.query("select id, sku, title, quantity, unit_price_minor, discount_minor, tax_minor from order_lines where org_id = $1 and order_id = $2 order by position", [orgId, candidate.order_id])
      : Promise.resolve([]),
    candidate.payment_transaction_id
      ? q.query(
          `select id, transaction_id, environment, occurred_at, trim(currency) as currency, gross_minor, refunded_minor, payer_name, payer_email, payer_country, dispute_state, invoice_id, source
             from payment_transactions where org_id = $1 and id = $2`,
          [orgId, candidate.payment_transaction_id],
        )
      : Promise.resolve([]),
    q.query(
      `select id, batch_id, kind, state, amount_minor, trim(currency) as currency, capture_id, provider_refund_id, provider_payout_item_id, provider_status,
              failure_code, failure_message, idempotency_key, manifest_version, reason, attempts, created_at, updated_at, completed_at
         from payment_operations where org_id = $1 and candidate_id = $2 order by created_at`,
      [orgId, candidateId],
    ),
    // Every PayPal payment tied to the order, however weakly: what a person chooses between when reconciling.
    candidate.order_id
      ? q.query(
          `select p.id, p.transaction_id, p.occurred_at, trim(p.currency) as currency, p.gross_minor, p.refunded_minor, p.payer_name, p.payer_email,
                  p.invoice_id, l.method, l.strength, l.detail,
                  (select count(*)::int from order_payment_links r where r.org_id = l.org_id and r.payment_transaction_id = l.payment_transaction_id and r.order_id <> l.order_id) as other_orders
             from order_payment_links l join payment_transactions p on p.org_id = l.org_id and p.id = l.payment_transaction_id
            where l.org_id = $1 and l.order_id = $2 order by p.occurred_at`,
          [orgId, candidate.order_id],
        )
      : Promise.resolve([]),
    candidate.order_id
      ? q.query(
          `select fl.order_line_id, fl.quantity, fl.batch_code, fl.serials, f.shipped_at, f.warehouse
             from fulfilment_lines fl join fulfilments f on f.org_id = fl.org_id and f.id = fl.fulfilment_id
            where fl.org_id = $1 and f.order_id = $2 order by f.shipped_at nulls last`,
          [orgId, candidate.order_id],
        )
      : Promise.resolve([]),
  ]);
  const { confirm_token_hash: _hidden, ...safe } = candidate;
  return { candidate: safe, evidence, calculation: calculation[0] ?? null, order: order[0] ?? null, lines, fulfilments, payment: payment[0] ?? null, paymentOptions, operations };
}

/**
 * The refund-intent ledger: every movement of money that was planned, with
 * why, for which order line, under which rules and approval, and what PayPal
 * said. Rows are written before PayPal is called.
 */
export async function ledger(q: Queryable, orgId: string, filter: { incidentId?: string; captureId?: string; state?: string }, page: Page) {
  const params: unknown[] = [orgId];
  let where = "";
  for (const [column, value] of [["op.incident_id", filter.incidentId], ["op.capture_id", filter.captureId], ["op.state", filter.state]] as const) {
    if (!value) continue;
    params.push(value);
    where += ` and ${column} = $${params.length}`;
  }
  const [total] = await q.query<{ n: number }>(`select count(*)::int as n from payment_operations op where op.org_id = $1 ${where}`, params);
  const rows = await q.query(
    `select op.id as operation_id, op.idempotency_key as request_id, op.kind, op.state, trim(op.currency) as currency, op.amount_minor,
            op.capture_id, op.recipient_type, op.reason, op.incident_id, i.title as incident_title, op.batch_id, b.name as batch_name,
            op.order_id, o.order_number, op.order_line_id, l.sku, op.rule_version_id, r.version as rule_version,
            op.manifest_id, op.manifest_version, op.capture_gross_minor, op.capture_refunded_before_minor,
            op.provider_refund_id, op.provider_payout_batch_id, op.provider_payout_item_id, op.provider_status, op.provider_amount_minor,
            op.failure_code, op.failure_message, op.attempts, op.created_at, op.updated_at, op.completed_at,
            (select count(*)::int from reconciliation_items ri where ri.org_id = op.org_id and ri.operation_id = op.id) as reconciliation_items,
            (select count(*)::int from reconciliation_items ri where ri.org_id = op.org_id and ri.operation_id = op.id and ri.status = 'open') as reconciliation_open
       from payment_operations op
       left join incidents i on i.org_id = op.org_id and i.id = op.incident_id
       left join batches b on b.org_id = op.org_id and b.id = op.batch_id
       left join orders o on o.org_id = op.org_id and o.id = op.order_id
       left join order_lines l on l.org_id = op.org_id and l.id = op.order_line_id
       left join incident_rule_versions r on r.org_id = op.org_id and r.id = op.rule_version_id
      where op.org_id = $1 ${where}
      order by op.created_at desc, op.id limit ${page.limit} offset ${page.offset}`,
    params,
  );
  return { total: total?.n ?? 0, rows };
}

/** One PayPal payment across every incident: what it was, what has gone back, what is planned, what is left. */
export async function captureBalance(q: Queryable, orgId: string, captureId: string) {
  const [payment] = await q.query<{ gross_minor: number; refunded_minor: number; currency: string } & Record<string, unknown>>(
    `select transaction_id, environment, occurred_at, trim(currency) as currency, gross_minor, refunded_minor, dispute_state, invoice_id, source, last_synced_at
       from payment_transactions where org_id = $1 and kind = 'payment' and transaction_id = $2`,
    [orgId, captureId],
  );
  if (!payment) return null;
  const operations = await q.query<{ state: string; amount_minor: number }>(
    `select op.id as operation_id, op.state, op.amount_minor, op.reason, op.incident_id, i.title as incident_title, op.provider_refund_id,
            op.manifest_version, op.created_at, op.completed_at
       from payment_operations op left join incidents i on i.org_id = op.org_id and i.id = op.incident_id
      where op.org_id = $1 and op.kind = 'refund' and op.capture_id = $2 order by op.created_at`,
    [orgId, captureId],
  );
  const sumOf = (states: string[]) => operations.filter((o) => states.includes(o.state)).reduce((a, o) => a + o.amount_minor, 0);
  const byUs = sumOf(["succeeded"]);
  const reserved = sumOf(["planned", "queued", "submitting", "unknown", "pending_provider", "failed_retryable"]);
  return {
    payment,
    refundedByMakeGoodMinor: byUs,
    refundedElsewhereMinor: Math.max(0, payment.refunded_minor - byUs),
    reservedMinor: reserved,
    availableMinor: Math.max(0, payment.gross_minor - payment.refunded_minor - reserved),
    operations,
  };
}

export async function listBatches(q: Queryable, orgId: string) {
  return q.query(
    `select b.id, b.name, b.status, b.totals, b.paused_reason, b.created_at, b.approved_at, b.started_at, b.finished_at,
            b.incident_id, i.title as incident_title,
            (select jsonb_object_agg(state, n) from (
               select state, count(*)::int as n from payment_operations op where op.org_id = b.org_id and op.batch_id = b.id group by state) s) as states
       from batches b join incidents i on i.org_id = b.org_id and i.id = b.incident_id
      where b.org_id = $1 order by b.created_at desc limit 200`,
    [orgId],
  );
}

export async function batchDetail(q: Queryable, orgId: string, batchId: string, page: Page) {
  const [batch] = await q.query(
    `select b.*, i.title as incident_title, u.name as created_by_name
       from batches b join incidents i on i.org_id = b.org_id and i.id = b.incident_id
       left join users u on u.id = b.created_by
      where b.org_id = $1 and b.id = $2`,
    [orgId, batchId],
  );
  if (!batch) return null;
  const [approvals, states, operations, total] = await Promise.all([
    q.query(
      `select a.decision, a.comment, a.created_at, u.name, u.email, a.manifest_hash,
              (select m.version from approval_manifests m where m.org_id = a.org_id and m.id = a.manifest_id) as manifest_version
         from batch_approvals a join users u on u.id = a.user_id where a.org_id = $1 and a.batch_id = $2 order by a.created_at`,
      [orgId, batchId],
    ),
    q.query<{ state: string; n: number; amount_minor: number; currency: string }>(
      `select state, trim(currency) as currency, count(*)::int as n, sum(amount_minor)::bigint as amount_minor
         from payment_operations where org_id = $1 and batch_id = $2 group by 1, 2`,
      [orgId, batchId],
    ),
    q.query(
      `select op.id, op.kind, op.state, op.amount_minor, trim(op.currency) as currency, op.capture_id, op.recipient_type,
              op.provider_refund_id, op.provider_payout_batch_id, op.provider_payout_item_id, op.provider_status,
              op.failure_code, op.failure_message, op.attempts, op.updated_at, op.completed_at, op.candidate_id,
              c.customer_name, c.customer_email, c.classification, c.payment_identity, c.eligibility,
              op.idempotency_key as request_id, op.reason, op.manifest_version, o.order_number
         from payment_operations op join candidates c on c.org_id = op.org_id and c.id = op.candidate_id
         left join orders o on o.org_id = op.org_id and o.id = op.order_id
        where op.org_id = $1 and op.batch_id = $2
        order by array_position(array['unknown','failed_retryable','failed_final','pending_provider','submitting','queued','planned','succeeded','cancelled'], op.state), op.created_at
        limit ${page.limit} offset ${page.offset}`,
      [orgId, batchId],
    ),
    q.query<{ n: number }>("select count(*)::int as n from payment_operations where org_id = $1 and batch_id = $2", [orgId, batchId]),
  ]);
  const manifests = await q.query(
    `select m.id, m.version, m.status, m.content_hash, m.item_count, m.created_at, m.invalidated_at, m.invalidated_reason, u.name as created_by
       from approval_manifests m left join users u on u.id = m.created_by
      where m.org_id = $1 and m.batch_id = $2 order by m.version desc`,
    [orgId, batchId],
  );
  return { batch, approvals, states, operations, totalOperations: total[0]?.n ?? 0, manifests };
}

export async function operationAttempts(q: Queryable, orgId: string, operationId: string) {
  return q.query(
    `select attempt_no, purpose, request_id, outcome, http_status, debug_id, error_code, started_at, finished_at
       from provider_attempts where org_id = $1 and operation_id = $2 order by attempt_no`,
    [orgId, operationId],
  );
}

export async function listPayments(q: Queryable, orgId: string, filter: { search?: string; kind?: string }, page: Page) {
  const params: unknown[] = [orgId];
  let where = "";
  if (filter.kind) {
    params.push(filter.kind);
    where += ` and p.kind = $${params.length}`;
  }
  if (filter.search) {
    params.push(`%${filter.search.toLowerCase()}%`);
    where += ` and (lower(p.transaction_id) like $${params.length} or lower(coalesce(p.payer_email, '')) like $${params.length} or lower(coalesce(p.invoice_id, '')) like $${params.length})`;
  }
  const [total] = await q.query<{ n: number }>(`select count(*)::int as n from payment_transactions p where p.org_id = $1 ${where}`, params);
  const rows = await q.query(
    `select p.id, p.transaction_id, p.environment, p.kind, p.event_code, p.provider_status, p.occurred_at, trim(p.currency) as currency,
            p.gross_minor, p.refunded_minor, p.payer_name, p.payer_email, p.payer_country, p.invoice_id, p.dispute_state,
            p.reference_transaction_id, p.source,
            (select o.order_number from order_payment_links l join orders o on o.org_id = l.org_id and o.id = l.order_id
              where l.org_id = p.org_id and l.payment_transaction_id = p.id limit 1) as order_number,
            (select l.strength from order_payment_links l where l.org_id = p.org_id and l.payment_transaction_id = p.id limit 1) as link_strength
       from payment_transactions p where p.org_id = $1 ${where}
      order by p.occurred_at desc limit ${page.limit} offset ${page.offset}`,
    params,
  );
  return { total: total?.n ?? 0, rows };
}

export async function listOrders(q: Queryable, orgId: string, filter: { search?: string }, page: Page) {
  const params: unknown[] = [orgId];
  let where = "";
  if (filter.search) {
    params.push(`%${filter.search.toLowerCase()}%`);
    where += ` and (lower(o.order_number) like $${params.length} or lower(coalesce(o.customer_email, '')) like $${params.length}
                    or exists (select 1 from order_lines l where l.org_id = o.org_id and l.order_id = o.id and lower(coalesce(l.sku, '')) like $${params.length}))`;
  }
  const [total] = await q.query<{ n: number }>(`select count(*)::int as n from orders o where o.org_id = $1 ${where}`, params);
  const rows = await q.query(
    `select o.id, o.order_number, o.placed_at, trim(o.currency) as currency, o.total_minor, o.payment_method, o.status,
            o.customer_name, o.customer_email, o.shipping_country, s.name as store,
            (select string_agg(l.quantity || ' x ' || coalesce(l.sku, l.title), ', ' order by l.position) from order_lines l
              where l.org_id = o.org_id and l.order_id = o.id) as items,
            (select string_agg(distinct fl.batch_code, ', ') from fulfilment_lines fl join fulfilments f on f.org_id = fl.org_id and f.id = fl.fulfilment_id
              where f.org_id = o.org_id and f.order_id = o.id and fl.batch_code is not null) as batch_codes,
            (select l.strength from order_payment_links l where l.org_id = o.org_id and l.order_id = o.id order by (l.strength = 'exact') desc limit 1) as link_strength
       from orders o join commerce_connections s on s.org_id = o.org_id and s.id = o.connection_id
      where o.org_id = $1 ${where}
      order by o.placed_at desc limit ${page.limit} offset ${page.offset}`,
    params,
  );
  return { total: total?.n ?? 0, rows };
}

export async function listDetections(q: Queryable, orgId: string, status: string | undefined) {
  return q.query(
    `select id, detector, severity, title, summary, evidence, status, incident_id, created_at, updated_at
       from detections where org_id = $1 ${status ? "and status = $2" : ""}
      order by array_position(array['critical','warning','info'], severity), updated_at desc limit 200`,
    status ? [orgId, status] : [orgId],
  );
}

export async function listReconciliation(q: Queryable, orgId: string) {
  return q.query(
    `select r.id, r.kind, r.severity, r.status, r.expected, r.actual, r.resolution, r.created_at, r.resolved_at, r.operation_id,
            op.batch_id, op.amount_minor, trim(op.currency) as currency, op.state as operation_state
       from reconciliation_items r left join payment_operations op on op.org_id = r.org_id and op.id = r.operation_id
      where r.org_id = $1 order by (r.status = 'open') desc, r.created_at desc limit 200`,
    [orgId],
  );
}

export async function auditPage(q: Queryable, orgId: string, page: Page) {
  const rows = await q.query(
    `select a.id, a.actor_kind, u.name as actor_name, a.action, a.entity_type, a.entity_id, a.data, a.created_at
       from audit_events a left join users u on u.id = a.actor_user_id
      where a.org_id = $1 order by a.id desc limit ${page.limit} offset ${page.offset}`,
    [orgId],
  );
  return { rows, chain: await verifyAuditChain(q, orgId) };
}

export async function analytics(q: Queryable, orgId: string) {
  const [byIncident, outcomes, timing, failures] = await Promise.all([
    q.query(
      `select i.id, i.title, i.kind, i.status,
              count(distinct c.id) filter (where c.status <> 'excluded')::int as affected,
              count(distinct op.id) filter (where op.state = 'succeeded')::int as paid,
              coalesce(sum(op.amount_minor) filter (where op.state = 'succeeded'), 0)::bigint as paid_minor
         from incidents i
         left join candidates c on c.org_id = i.org_id and c.incident_id = i.id
         left join payment_operations op on op.org_id = c.org_id and op.candidate_id = c.id
        where i.org_id = $1 group by i.id, i.title, i.kind, i.status order by i.created_at desc`,
      [orgId],
    ),
    q.query(
      `select kind, state, trim(currency) as currency, count(*)::int as n, sum(amount_minor)::bigint as amount_minor
         from payment_operations where org_id = $1 group by 1, 2, 3 order by 1, 2`,
      [orgId],
    ),
    q.query(
      `select b.id, b.name,
              extract(epoch from (b.approved_at - b.created_at))::int as seconds_to_approval,
              extract(epoch from (b.finished_at - b.started_at))::int as seconds_to_finish
         from batches b where b.org_id = $1 and b.started_at is not null order by b.created_at desc limit 50`,
      [orgId],
    ),
    q.query(
      `select coalesce(failure_code, 'UNKNOWN') as failure_code, count(*)::int as n
         from payment_operations where org_id = $1 and state in ('failed_final', 'failed_retryable') group by 1 order by 2 desc`,
      [orgId],
    ),
  ]);
  return { byIncident, outcomes, timing, failures };
}

/** Hides most of a customer's email in a list view, for staff who only need to recognise a row. */
export function masked<T extends { customer_email?: string | null }>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, customer_email: r.customer_email ? maskEmail(r.customer_email) : r.customer_email }));
}
