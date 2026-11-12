// Continuous monitoring: things a merchant should look at even when no
// incident is open. This is the reason to open Make Good on an ordinary day.
//
// Every detector here runs on data we really hold: the merchant's PayPal
// transactions, their orders, and our own payment operations. None uses
// PayPal risk scores or complaint data, because no supported API gives us
// those. Each finding says what it is based on and what it cannot tell.

import { queueAlert } from "../notify/alerts.ts";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import { DAY } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { ConflictError, NotFoundError } from "../../platform/errors.ts";
import { formatMoney } from "../../platform/money.ts";
import { addRuleVersion, createIncident, loadMatchData } from "../incidents/service.ts";
import { runMatch } from "../matching/engine.ts";

export type Deps = { db: Db; clock: Clock };

type Finding = {
  detector: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
};

export const DETECTORS = [
  {
    id: "duplicate_charge",
    needs: "PayPal transactions (Transaction Search). Better with orders, which separate a double charge from a customer buying twice.",
    limits: "Needs the payer's PayPal account or email on both payments. PayPal data can be up to three hours behind.",
  },
  {
    id: "refund_rate_spike",
    needs: "At least five weeks of PayPal transactions.",
    limits: "A rise in refunds is a signal, not a cause. Small shops with few payments are not flagged.",
  },
  {
    id: "failed_refunds",
    needs: "Refunds and payouts sent through Make Good.",
    limits: "Does not see refunds made directly in PayPal.",
  },
  {
    id: "unknown_outcomes",
    needs: "Refunds and payouts sent through Make Good.",
    limits: "None: this is our own state.",
  },
  {
    id: "reconciliation_mismatch",
    needs: "Refunds sent through Make Good and PayPal's reply to them.",
    limits: "None: this compares our record with PayPal's.",
  },
  {
    id: "repeat_incident_sku",
    needs: "Two or more incidents that name products.",
    limits: "Only incidents recorded here are counted.",
  },
  {
    id: "stale_incident",
    needs: "Open incidents with confirmed customers.",
    limits: "None: this is our own state.",
  },
] as const;

async function raise(tx: Queryable, orgId: string, finding: Finding, now: Date): Promise<boolean> {
  const rows = await tx.query<{ id: string; created: boolean }>(
    `insert into detections (org_id, detector, severity, title, summary, evidence, fingerprint, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8)
     on conflict (org_id, fingerprint) do update set
       severity = excluded.severity, title = excluded.title, summary = excluded.summary,
       evidence = excluded.evidence, updated_at = excluded.updated_at
     returning id, (xmax = 0) as created`,
    [orgId, finding.detector, finding.severity, finding.title, finding.summary, json(finding.evidence), finding.fingerprint, now.toISOString()],
  );
  if (rows[0]?.created && finding.severity === "critical") await queueAlert(tx, orgId, { kind: "detection.raised", detectionId: rows[0].id }, now);
  return rows[0]?.created ?? false;
}

async function duplicateCharges(db: Db, orgId: string, now: Date, days: number): Promise<Finding[]> {
  const from = new Date(now.getTime() - days * DAY).toISOString();
  const scope = { type: "duplicate_charge" as const, from, to: now.toISOString(), windowMinutes: 10 };
  const data = await loadMatchData(db, orgId, scope);
  const { candidates } = runMatch({ scope, now, orders: data.orders, payments: data.payments, batches: [] });
  const payments = new Map(data.payments.map((p) => [p.id, p]));
  // A duplicate already being handled by an incident is not raised again.
  const handled = new Set(
    (await db.query<{ payment_transaction_id: string }>(
      "select payment_transaction_id from candidates where org_id = $1 and subject_key like 'dup:%' and payment_transaction_id is not null",
      [orgId],
    )).map((r) => r.payment_transaction_id),
  );
  const out: Finding[] = [];
  for (const c of candidates) {
    if (c.status === "excluded" || !c.paymentId || handled.has(c.paymentId)) continue;
    const p = payments.get(c.paymentId);
    if (!p) continue;
    const proven = c.classification === "exact_unit";
    out.push({
      detector: "duplicate_charge",
      severity: proven ? "critical" : "warning",
      title: proven ? `A customer was charged twice (${formatMoney(p.grossMinor, p.currency)})` : `Possible double charge (${formatMoney(p.grossMinor, p.currency)})`,
      summary: c.evidence.map((e) => e.fact).join(" "),
      evidence: {
        paymentId: p.id, transactionId: p.transactionId, occurredAt: p.occurredAt.toISOString(), amountMinor: p.grossMinor,
        currency: p.currency, classification: c.classification, facts: c.evidence, missing: c.missing,
      },
      fingerprint: `duplicate_charge:${p.id}`,
    });
  }
  return out;
}

async function refundRateSpike(db: Db, orgId: string, now: Date): Promise<Finding[]> {
  const week = (n: number) => new Date(now.getTime() - n * 7 * DAY).toISOString();
  const rows = await db.query<{ bucket: number; kind: string; n: number }>(
    `select case when occurred_at >= $2 then 0 else 1 end as bucket, kind, count(*)::int as n
       from payment_transactions
      where org_id = $1 and kind in ('payment', 'refund') and occurred_at >= $3 and occurred_at <= $4
      group by 1, 2`,
    [orgId, week(1), week(5), now.toISOString()],
  );
  const count = (bucket: number, kind: string) => rows.find((r) => r.bucket === bucket && r.kind === kind)?.n ?? 0;
  const recentPayments = count(0, "payment");
  const recentRefunds = count(0, "refund");
  const basePayments = count(1, "payment");
  const baseRefunds = count(1, "refund");
  // Too little data to say anything: do not flag.
  if (recentRefunds < 5 || basePayments < 40 || recentPayments < 10) return [];
  const recentRate = recentRefunds / recentPayments;
  const baseRate = baseRefunds / basePayments;
  if (recentRate < Math.max(0.02, baseRate * 2)) return [];
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  return [{
    detector: "refund_rate_spike",
    severity: "warning",
    title: `Refunds rose to ${pct(recentRate)} of payments this week`,
    summary: `${recentRefunds} refunds against ${recentPayments} payments in the last 7 days (${pct(recentRate)}), compared with ${pct(baseRate)} over the four weeks before. This shows a change, not its cause.`,
    evidence: { recentPayments, recentRefunds, basePayments, baseRefunds, recentRate, baseRate },
    fingerprint: `refund_rate_spike:${week(1).slice(0, 10)}`,
  }];
}

async function operationalFindings(db: Db, orgId: string, now: Date): Promise<Finding[]> {
  const out: Finding[] = [];
  const failed = await db.query<{ failure_code: string; n: number; batch_id: string }>(
    `select coalesce(failure_code, 'UNKNOWN') as failure_code, batch_id, count(*)::int as n
       from payment_operations where org_id = $1 and state = 'failed_final' and updated_at >= $2
      group by 1, 2`,
    [orgId, new Date(now.getTime() - 14 * DAY).toISOString()],
  );
  for (const f of failed) {
    out.push({
      detector: "failed_refunds", severity: "warning",
      title: `${f.n} payment${f.n === 1 ? "" : "s"} refused by PayPal (${f.failure_code})`,
      summary: `PayPal refused ${f.n} operation(s) in one batch with the reason ${f.failure_code}. These customers have not been paid.`,
      evidence: { batchId: f.batch_id, failureCode: f.failure_code, count: f.n },
      fingerprint: `failed_refunds:${f.batch_id}:${f.failure_code}`,
    });
  }
  const unknown = await db.query<{ id: string; batch_id: string; amount_minor: number; currency: string; updated_at: Date }>(
    `select id, batch_id, amount_minor, trim(currency) as currency, updated_at from payment_operations
      where org_id = $1 and state = 'unknown' and updated_at < $2`,
    [orgId, new Date(now.getTime() - 15 * 60_000).toISOString()],
  );
  for (const u of unknown) {
    out.push({
      detector: "unknown_outcomes", severity: "critical",
      title: `A payment of ${formatMoney(u.amount_minor, u.currency)} has had no answer from PayPal for over 15 minutes`,
      summary: "We asked PayPal to move this money and do not yet know whether it did. It is being looked up automatically and will not be sent twice.",
      evidence: { operationId: u.id, batchId: u.batch_id, since: new Date(u.updated_at).toISOString() },
      fingerprint: `unknown_outcomes:${u.id}`,
    });
  }
  const mismatches = await db.query<{ id: string; kind: string; operation_id: string | null }>(
    "select id, kind, operation_id from reconciliation_items where org_id = $1 and status = 'open' and severity = 'critical'",
    [orgId],
  );
  for (const m of mismatches) {
    out.push({
      detector: "reconciliation_mismatch", severity: "critical",
      title: "Our record and PayPal's record of a payment do not agree",
      summary: `Reconciliation found a difference of type "${m.kind}". A person should check it in PayPal.`,
      evidence: { reconciliationItemId: m.id, operationId: m.operation_id, kind: m.kind },
      fingerprint: `reconciliation_mismatch:${m.id}`,
    });
  }
  const stale = await db.query<{ id: string; title: string; waiting: number }>(
    `select i.id, i.title, count(*)::int as waiting
       from incidents i join candidates c on c.org_id = i.org_id and c.incident_id = i.id
      where i.org_id = $1 and i.status = 'active' and c.status = 'confirmed' and c.updated_at < $2
        and not exists (select 1 from payment_operations op where op.org_id = c.org_id and op.candidate_id = c.id
                         and op.state in ('queued','submitting','unknown','pending_provider','succeeded'))
      group by i.id, i.title`,
    [orgId, new Date(now.getTime() - 14 * DAY).toISOString()],
  );
  for (const s of stale) {
    out.push({
      detector: "stale_incident", severity: "info",
      title: `${s.waiting} confirmed customer${s.waiting === 1 ? " has" : "s have"} waited over two weeks`,
      summary: `Incident "${s.title}" has confirmed customers who have not been paid and are not in a batch.`,
      evidence: { incidentId: s.id, waiting: s.waiting },
      fingerprint: `stale_incident:${s.id}`,
    });
  }
  const repeats = await db.query<{ sku: string; incidents: number }>(
    `select sku, count(distinct incident_id)::int as incidents from (
       select r.incident_id, upper(trim(jsonb_array_elements_text(r.scope->'skus'))) as sku
         from incident_rule_versions r join incidents i on i.org_id = r.org_id and i.id = r.incident_id
        where r.org_id = $1 and i.created_at >= $2 and jsonb_typeof(r.scope->'skus') = 'array') s
      group by sku having count(distinct incident_id) >= 2`,
    [orgId, new Date(now.getTime() - 180 * DAY).toISOString()],
  );
  for (const r of repeats) {
    out.push({
      detector: "repeat_incident_sku", severity: "warning",
      title: `Product ${r.sku} has been in ${r.incidents} incidents in six months`,
      summary: "The same product keeps needing compensation. It may be worth raising with the supplier.",
      evidence: { sku: r.sku, incidents: r.incidents },
      fingerprint: `repeat_incident_sku:${r.sku}:${r.incidents}`,
    });
  }
  return out;
}

export async function runDetectors(deps: Deps, orgId: string, options: { duplicateLookbackDays?: number } = {}): Promise<{ raised: number; open: number }> {
  const now = deps.clock.now();
  const findings = [
    ...(await duplicateCharges(deps.db, orgId, now, options.duplicateLookbackDays ?? 14)),
    ...(await refundRateSpike(deps.db, orgId, now)),
    ...(await operationalFindings(deps.db, orgId, now)),
  ];
  let raised = 0;
  await deps.db.tx(async (tx) => {
    for (const f of findings) if (await raise(tx, orgId, f, now)) raised++;
  });
  const [open] = await deps.db.query<{ n: number }>("select count(*)::int as n from detections where org_id = $1 and status = 'open'", [orgId]);
  return { raised, open: open?.n ?? 0 };
}

export async function setDetectionStatus(
  deps: Deps,
  input: { orgId: string; detectionId: string; userId: string; status: "open" | "acknowledged" | "dismissed" },
): Promise<void> {
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    const rows = await tx.query(
      "update detections set status = $3, updated_at = $4 where org_id = $1 and id = $2 and status <> 'converted' returning id",
      [input.orgId, input.detectionId, input.status, now.toISOString()],
    );
    if (rows.length === 0) throw new NotFoundError("Detection");
    await audit(tx, { orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `detection.${input.status}`, entityType: "detection", entityId: input.detectionId, at: now });
  });
}

/** Turns a suspected double charge into an incident with the right rules already filled in. */
export async function convertDetection(deps: Deps, input: { orgId: string; detectionId: string; userId: string }): Promise<{ incidentId: string }> {
  const [d] = await deps.db.query<{ detector: string; status: string; evidence: { occurredAt?: string }; title: string }>(
    "select detector, status, evidence, title from detections where org_id = $1 and id = $2",
    [input.orgId, input.detectionId],
  );
  if (!d) throw new NotFoundError("Detection");
  if (d.status === "converted") throw new ConflictError("ALREADY_CONVERTED", "This finding already has an incident.");
  if (d.detector !== "duplicate_charge" || !d.evidence.occurredAt) {
    throw new ConflictError("NOT_CONVERTIBLE", "Only double-charge findings can be turned into an incident automatically.");
  }
  // A billing fault rarely hits one customer, so the incident covers every open
  // double-charge finding, not only the one that was clicked.
  const open = await deps.db.query<{ id: string; evidence: { occurredAt?: string } }>(
    "select id, evidence from detections where org_id = $1 and detector = 'duplicate_charge' and status in ('open', 'acknowledged')",
    [input.orgId],
  );
  const times = [d.evidence.occurredAt, ...open.map((o) => o.evidence.occurredAt)]
    .filter((t): t is string => typeof t === "string")
    .map((t) => new Date(t).getTime());
  const margin = 15 * 60_000;
  const from = new Date(Math.min(...times) - margin).toISOString();
  const to = new Date(Math.max(...times) + margin).toISOString();
  const { id: incidentId } = await createIncident(deps, {
    orgId: input.orgId, userId: input.userId, kind: "duplicate_charge", title: d.title,
    description: "Opened from monitoring: payments that repeat an earlier payment from the same payer for the same amount.",
  });
  await addRuleVersion(deps, {
    orgId: input.orgId, incidentId, userId: input.userId,
    scope: { type: "duplicate_charge", from, to, windowMinutes: 10 },
    compensation: {
      type: "duplicate_payment", includeTax: true, includeShipping: false, minMinor: null, maxMinor: null,
      rounding: "half_up", allowPayout: false, refundWindowDays: 180,
    },
  });
  const ids = [...new Set([input.detectionId, ...open.map((o) => o.id)])];
  const marks = ids.map((_, i) => "$" + (i + 4)).join(", ");
  await deps.db.query(
    "update detections set status = 'converted', incident_id = $2, updated_at = $3 where org_id = $1 and id in (" + marks + ")",
    [input.orgId, incidentId, deps.clock.now().toISOString(), ...ids],
  );
  return { incidentId };
}
