// The Recovery Map: one picture of everyone who bought the product, where
// each of them stands, and why.
//
// Everything here is read from stored state: the two answers the matching
// engine gave for each record, the evidence behind them, the calculation, and
// what PayPal said about any payment. Nothing is estimated, and nothing in
// this file can cause a payment. A record's place on the map is a description
// of it, not a permission.

import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { NotFoundError, ValidationError } from "../../platform/errors.ts";
import { z } from "zod";
import { calculateCompensation, CompensationRule } from "../compensation/engine.ts";
import { latestRuleVersion, loadOrders, loadPayments } from "../incidents/service.ts";
import { describeRule } from "../execution/manifests.ts";
import type { Classification, Eligibility } from "../matching/types.ts";

/** Where a record stands today. Worked out from stored status, the engine's decision and the latest payment. */
export type Disposition =
  | "paid" // PayPal confirmed the refund or payout
  | "in_progress" // sent or queued; not yet confirmed
  | "outcome_unknown" // sent, and we do not know whether PayPal acted; being looked up
  | "payment_failed" // PayPal refused, or the worker withheld it
  | "in_a_batch" // on a payment list that has not started
  | "ready" // can go on a payment list for a person to approve
  | "needs_eligibility_evidence"
  | "reconcile_payment"
  | "investigate"
  | "pay_outside_paypal"
  | "needs_manual_handling" // payable, but not automatically (currency, age, no route)
  | "nothing_to_pay"
  | "on_hold" // a PayPal dispute is open
  | "excluded" // returned, cancelled, already refunded in full
  | "declined" // a person decided not to pay
  | "not_affected";

export const DISPOSITION_ORDER: readonly Disposition[] = [
  "ready", "in_a_batch", "in_progress", "outcome_unknown", "paid", "payment_failed",
  "needs_eligibility_evidence", "reconcile_payment", "investigate",
  "pay_outside_paypal", "needs_manual_handling", "on_hold", "excluded", "declined", "nothing_to_pay", "not_affected",
];

const DISPOSITION_TEXT: Record<Disposition, { label: string; why: string; group: "payable" | "paid" | "held" | "left_out" }> = {
  ready: { label: "Ready for approval", why: "The payment is verified and the unit is proven, or a named person confirmed the record. Nothing is paid until a payment list is approved.", group: "payable" },
  in_a_batch: { label: "On a payment list", why: "Listed on a batch that has not started.", group: "payable" },
  in_progress: { label: "Being paid", why: "Sent to PayPal or waiting in the queue. Not shown as paid until PayPal confirms.", group: "payable" },
  outcome_unknown: { label: "Outcome unknown", why: "The request was sent and the reply was lost. The system is asking PayPal what happened, with the same request ID. It will not send a second request.", group: "payable" },
  paid: { label: "Paid", why: "PayPal confirmed the payment.", group: "paid" },
  payment_failed: { label: "Payment failed", why: "PayPal refused the payment, or the worker withheld it because its approval no longer covered it. It was not rerouted.", group: "held" },
  needs_eligibility_evidence: { label: "Needs evidence of the unit", why: "The payment is verified, but no record proves which unit the customer received.", group: "held" },
  reconcile_payment: { label: "Reconcile the payment", why: "The unit is proven, but it is not settled which PayPal payment paid for the order.", group: "held" },
  investigate: { label: "Investigate", why: "Neither the payment nor the unit is settled.", group: "held" },
  pay_outside_paypal: { label: "Owed outside PayPal", why: "Affected, but the order was not paid through PayPal.", group: "held" },
  needs_manual_handling: { label: "Needs a person", why: "Owed, but it cannot be refunded to the original payment automatically.", group: "held" },
  on_hold: { label: "On hold: dispute open", why: "A PayPal dispute is open on the payment. Refunding outside it could pay twice.", group: "left_out" },
  excluded: { label: "Excluded", why: "Returned, cancelled, or already refunded in full.", group: "left_out" },
  declined: { label: "Declined by a person", why: "A member of staff decided not to pay this record.", group: "left_out" },
  nothing_to_pay: { label: "Nothing left to pay", why: "Affected, but the rule leaves nothing to pay on this payment.", group: "left_out" },
  not_affected: { label: "Not affected", why: "The records show this purchase was not affected.", group: "left_out" },
};

/** SQL for the disposition, so lists can be filtered and sorted by it in the database. */
export const DISPOSITION_SQL = `
  case
    when c.status = 'cleared' then 'not_affected'
    when lo.state = 'succeeded' then 'paid'
    when lo.state in ('queued', 'submitting', 'pending_provider') then 'in_progress'
    when lo.state = 'unknown' then 'outcome_unknown'
    when lo.state in ('failed_final', 'failed_retryable') or (lo.state = 'cancelled' and lo.failure_code = 'APPROVAL_NO_LONGER_COVERS') then 'payment_failed'
    when lo.state = 'planned' then 'in_a_batch'
    when c.status = 'excluded' and c.exclusion_code = 'dispute_open' then 'on_hold'
    when c.status = 'excluded' then 'excluded'
    when c.status = 'declined' then 'declined'
    when c.status = 'proposed' then c.decision
    when c.decision = 'pay_outside_paypal' and c.decided_by is null then 'pay_outside_paypal'
    when k.route in ('refund_original', 'payout') and k.payable_minor > 0 then 'ready'
    when k.route = 'manual' then 'needs_manual_handling'
    else 'nothing_to_pay'
  end`;

/** The joins every map query shares: current calculation, payment, order, line, and the latest payment operation. */
export const MAP_FROM = `
  from candidates c
  left join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
  left join payment_transactions p on p.org_id = c.org_id and p.id = c.payment_transaction_id
  left join orders o on o.org_id = c.org_id and o.id = c.order_id
  left join order_lines l on l.org_id = c.org_id and l.id = c.order_line_id
  left join users u on u.id = c.decided_by
  left join lateral (
    select op.id, op.state, op.failure_code, op.failure_message, op.amount_minor, op.kind, op.provider_refund_id,
           op.provider_payout_item_id, op.provider_status, op.batch_id, op.manifest_version, op.completed_at, op.attempts
      from payment_operations op
     where op.org_id = c.org_id and op.candidate_id = c.id
     order by op.created_at desc, op.id desc limit 1) lo on true`;

type MoneyByCurrency = Record<string, number>;
const add = (into: MoneyByCurrency, currency: string | null, minor: number | null) => {
  if (currency && minor) into[currency] = (into[currency] ?? 0) + minor;
};

export async function recoveryMap(q: Queryable, orgId: string, incidentId: string) {
  const [incident] = await q.query<{ id: string; kind: string; title: string; description: string; status: string; created_at: Date }>(
    "select id, kind, title, description, status, created_at from incidents where org_id = $1 and id = $2",
    [orgId, incidentId],
  );
  if (!incident) throw new NotFoundError("Incident");
  const [rule, lastRun, connection, org, documents, labelled] = await Promise.all([
    q.query<{ id: string; version: number; scope: unknown; compensation: unknown; created_at: Date }>(
      "select id, version, scope, compensation, created_at from incident_rule_versions where org_id = $1 and incident_id = $2 order by version desc limit 1",
      [orgId, incidentId],
    ),
    q.query<{ stats: Record<string, unknown>; finished_at: Date; rule_version_id: string }>(
      "select stats, finished_at, rule_version_id from match_runs where org_id = $1 and incident_id = $2 order by started_at desc limit 1",
      [orgId, incidentId],
    ),
    q.query<{ environment: string }>(
      "select environment from paypal_connections where org_id = $1 and status = 'connected' order by (environment = 'live') desc, created_at limit 1",
      [orgId],
    ),
    q.query<{ settings: { demoData?: boolean } }>("select settings from organisations where id = $1", [orgId]),
    q.query<{ id: string; kind: string; title: string; data_label: string; created_at: Date }>(
      "select id, kind, title, data_label, created_at from incident_documents where org_id = $1 and incident_id = $2 order by created_at",
      [orgId, incidentId],
    ),
    q.query<{ n: number }>("select count(*)::int as n from evaluation_labels where org_id = $1", [orgId]),
  ]);

  const rows = await q.query<{
    disposition: Disposition; payment_identity: string; eligibility: string; status: string; exclusion_code: string | null;
    affected_quantity: number; currency: string | null; payable_minor: number | null; paid_minor: number | null; n: number;
  }>(
    `select ${DISPOSITION_SQL} as disposition, c.payment_identity, c.eligibility, c.status, c.exclusion_code,
            sum(c.affected_quantity)::int as affected_quantity, trim(k.currency) as currency,
            sum(coalesce(k.payable_minor, 0))::bigint as payable_minor,
            sum(case when lo.state = 'succeeded' then lo.amount_minor else 0 end)::bigint as paid_minor,
            count(*)::int as n
       ${MAP_FROM}
      where c.org_id = $1 and c.incident_id = $2
      group by 1, 2, 3, 4, 5, trim(k.currency)`,
    [orgId, incidentId],
  );

  const dispositions = new Map<Disposition, { count: number; units: number; amount: MoneyByCurrency; paid: MoneyByCurrency }>();
  const matrix = new Map<string, { paymentIdentity: string; eligibility: string; count: number; units: number; amount: MoneyByCurrency }>();
  const restricted: Record<string, number> = {};
  for (const r of rows) {
    const d = dispositions.get(r.disposition) ?? { count: 0, units: 0, amount: {}, paid: {} };
    d.count += r.n;
    d.units += r.affected_quantity;
    add(d.amount, r.currency, r.payable_minor);
    add(d.paid, r.currency, r.paid_minor);
    dispositions.set(r.disposition, d);
    if (r.status !== "cleared") {
      const key = `${r.payment_identity}|${r.eligibility}`;
      const m = matrix.get(key) ?? { paymentIdentity: r.payment_identity, eligibility: r.eligibility, count: 0, units: 0, amount: {} };
      m.count += r.n;
      m.units += r.affected_quantity;
      add(m.amount, r.currency, r.payable_minor);
      matrix.set(key, m);
    }
    if (r.status === "excluded") restricted[r.exclusion_code ?? "other"] = (restricted[r.exclusion_code ?? "other"] ?? 0) + r.n;
  }

  const groups = DISPOSITION_ORDER.filter((d) => dispositions.has(d)).map((d) => ({ disposition: d, ...DISPOSITION_TEXT[d], ...dispositions.get(d)! }));
  const sum = (group: string, field: "amount" | "paid") => {
    const out: MoneyByCurrency = {};
    for (const g of groups) if (g.group === group) for (const [cur, minor] of Object.entries(g[field])) add(out, cur, minor);
    return out;
  };
  const environment = connection[0]?.environment ?? "none";
  return {
    incident,
    rule: rule[0] ? { ...rule[0], compensationInWords: describeRule(rule[0].compensation) } : null,
    documents,
    lastMatch: lastRun[0] ?? null,
    /** Where the money in this incident is. A screen must show this next to every amount. */
    dataLabels: {
      paypal: environment,
      paypalMeaning:
        environment === "simulator" ? "Built-in simulator. No request leaves this machine and no money exists."
        : environment === "sandbox" ? "PayPal's sandbox. Requests reach PayPal and get PayPal's own answers. The money is test money."
        : environment === "live" ? "Live PayPal. Real money."
        : "No PayPal account is connected.",
      merchantRecords: org[0]?.settings?.demoData ? "synthetic" : "merchant",
      knownAnswersAvailable: (labelled[0]?.n ?? 0) > 0,
    },
    groups,
    /** The two questions, crossed. Records shown not to be affected are left out of this table. */
    matrix: [...matrix.values()],
    restricted,
    liability: {
      readyOrOnAList: sum("payable", "amount"),
      heldIfConfirmed: sum("held", "amount"),
      paid: sum("paid", "paid"),
    },
  };
}

// ---------- comparing policies ----------

const INCLUDE = z.array(z.enum(["proven", "supported", "uncertain", "unknown"])).min(1);
export const PolicyInput = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  /** Which answers to the eligibility question this policy pays. */
  include: INCLUDE,
  /** Ask everyone the policy does not pay to confirm the code on their unit. */
  askTheRest: z.boolean().default(false),
  /** A different compensation rule to price. Left out: the incident's current rule. */
  compensation: CompensationRule.optional(),
});
export type PolicyInput = z.infer<typeof PolicyInput>;

const DEFAULT_POLICIES: PolicyInput[] = [
  { key: "proven_only", label: "Pay only customers whose unit is proven", include: ["proven"], askTheRest: false },
  { key: "ask_the_rest", label: "Pay proven units now, and ask the others to confirm their batch code", include: ["proven"], askTheRest: true },
  { key: "include_likely", label: "Also pay customers who are likely affected, after you review them", include: ["proven", "supported", "uncertain"], askTheRest: false },
];

type Bucket = { customers: number; units: number; amount: MoneyByCurrency };
const bucket = (): Bucket => ({ customers: 0, units: 0, amount: {} });
const put = (b: Bucket, units: number, currency: string, minor: number) => {
  b.customers++;
  b.units += units;
  add(b.amount, currency, minor);
};

/**
 * Prices each policy against the records as they stand. A dry calculation:
 * it writes nothing, changes no record and cannot start a payment. Choosing a
 * policy is done afterwards, by a person, through the normal confirm and
 * rule-change steps, each of which is recorded.
 */
export async function comparePolicies(
  deps: { db: Db; clock: Clock },
  input: { orgId: string; incidentId: string; policies?: PolicyInput[]; payoutsAvailable: boolean },
) {
  const { db, clock } = deps;
  const rule = await latestRuleVersion(db, input.orgId, input.incidentId);
  if (!rule) throw new ValidationError("This incident has no rules yet, so there is nothing to price.");
  const policies = input.policies && input.policies.length > 0 ? input.policies : DEFAULT_POLICIES;
  const rows = await db.query<{
    id: string; order_id: string | null; order_line_id: string | null; payment_transaction_id: string | null; status: string;
    payment_identity: string; eligibility: Eligibility; classification: Classification; affected_quantity: number; facts: Record<string, unknown>;
    customer_email: string | null; decided_by: string | null; already_paid: boolean; truth_units: number | null;
  }>(
    `select c.id, c.order_id, c.order_line_id, c.payment_transaction_id, c.status, c.payment_identity, c.eligibility, c.classification,
            c.affected_quantity, c.facts, c.customer_email, c.decided_by,
            exists (select 1 from payment_operations op where op.org_id = c.org_id and op.candidate_id = c.id
                     and op.state in ('queued', 'submitting', 'unknown', 'pending_provider', 'succeeded')) as already_paid,
            (select e.affected_units from evaluation_labels e where e.org_id = c.org_id and e.order_line_id = c.order_line_id limit 1) as truth_units
       from candidates c
      where c.org_id = $1 and c.incident_id = $2 and c.status in ('proposed', 'confirmed')`,
    [input.orgId, input.incidentId],
  );
  const orders = new Map((await loadOrders(db, input.orgId, [...new Set(rows.map((r) => r.order_id).filter((x): x is string => !!x))])).map((o) => [o.id, o]));
  const payments = new Map(
    (await loadPayments(db, input.orgId, [...new Set(rows.map((r) => r.payment_transaction_id).filter((x): x is string => !!x))])).map((p) => [p.id, p]),
  );
  const now = clock.now();
  const known = rows.some((r) => r.truth_units !== null);

  return {
    asOf: now.toISOString(),
    currentRule: { ruleVersionId: rule.id, version: rule.version, inWords: describeRule(rule.compensation) },
    note: "A dry calculation on the records as they stand. Nothing is saved and nothing is paid. Amounts use the same calculation the payment list uses.",
    policies: policies.map((policy) => {
      const compensation = policy.compensation ?? rule.compensation;
      const include = new Set<string>(policy.include);
      const out = {
        key: policy.key,
        label: policy.label,
        compensationInWords: describeRule(compensation),
        include: policy.include,
        /** Refundable to the original PayPal payment as soon as a list is approved. */
        payNow: bucket(),
        /** Of payNow: customers whose unit no record proves. This is the exposure to paying someone who was not affected. */
        ofWhichUnproven: bucket(),
        /** Included by the policy, but the payment is not settled, so nothing can be sent yet. */
        blockedUntilPaymentReconciled: bucket(),
        /** Owed, but not through a PayPal refund: paid another way, too old, or needing a person. */
        outsidePayPalOrManual: bucket(),
        /** Possibly affected customers the policy does not pay. */
        notPaid: bucket(),
        /** Customers who would be asked to confirm the code on their unit. */
        askedToConfirm: policy.askTheRest ? 0 : null as number | null,
        /** The most that could be added if every customer asked turned out to be affected. */
        additionalIfAllConfirm: policy.askTheRest ? bucket() : null as Bucket | null,
        alreadyPaidOrInProgress: 0,
        tradeOff: "",
        /** Present only for sample data with known answers. */
        againstKnownAnswers: known ? { unitsPaidThatWereNotAffected: 0, affectedUnitsNotPaidNow: 0 } : null,
      };
      for (const r of rows) {
        if (r.already_paid) {
          out.alreadyPaidOrInProgress++;
          continue;
        }
        const order = r.order_id ? orders.get(r.order_id) ?? null : null;
        const calc = calculateCompensation({
          rule: compensation, now,
          candidate: { affectedQuantity: r.affected_quantity, classification: r.classification, facts: r.facts as never, customerEmail: r.customer_email },
          order, line: order && r.order_line_id ? order.lines.find((l) => l.id === r.order_line_id) ?? null : null,
          payment: r.payment_transaction_id ? payments.get(r.payment_transaction_id) ?? null : null,
          payoutsAvailable: input.payoutsAvailable,
        });
        // A record a named person already confirmed is paid under any policy: that decision was theirs to make.
        const covered = include.has(r.eligibility) || (r.status === "confirmed" && r.decided_by !== null);
        const truth = r.truth_units;
        if (!covered) {
          put(out.notPaid, r.affected_quantity, calc.currency, calc.payableMinor);
          if (policy.askTheRest) {
            out.askedToConfirm = (out.askedToConfirm ?? 0) + 1;
            put(out.additionalIfAllConfirm!, r.affected_quantity, calc.currency, calc.payableMinor);
          }
          if (out.againstKnownAnswers && truth !== null) out.againstKnownAnswers.affectedUnitsNotPaidNow += Math.min(truth, r.affected_quantity);
          continue;
        }
        if (calc.route === "refund_original" && r.payment_identity === "verified") {
          put(out.payNow, r.affected_quantity, calc.currency, calc.payableMinor);
          if (r.eligibility !== "proven") put(out.ofWhichUnproven, r.affected_quantity, calc.currency, calc.payableMinor);
          if (out.againstKnownAnswers && truth !== null) out.againstKnownAnswers.unitsPaidThatWereNotAffected += Math.max(0, r.affected_quantity - truth);
        } else {
          if (calc.route === "refund_original") put(out.blockedUntilPaymentReconciled, r.affected_quantity, calc.currency, calc.payableMinor);
          else if (calc.payableMinor > 0 || calc.route === "manual") put(out.outsidePayPalOrManual, r.affected_quantity, calc.currency, calc.payableMinor);
          if (out.againstKnownAnswers && truth !== null) out.againstKnownAnswers.affectedUnitsNotPaidNow += Math.min(truth, r.affected_quantity);
        }
      }
      out.tradeOff =
        out.ofWhichUnproven.customers > 0
          ? `Pays ${out.ofWhichUnproven.customers} customer(s) whose unit no record proves. Faster for them, and each one is a payment you may not owe.`
          : policy.askTheRest
            ? `Pays nobody without proof. ${out.askedToConfirm} customer(s) must reply before they are paid, and some will not reply.`
            : out.notPaid.customers > 0
              ? `Pays nobody without proof. ${out.notPaid.customers} possibly affected customer(s) are left unpaid unless they come forward.`
              : "Every possibly affected customer is covered by proof.";
      return out;
    }),
  };
}

// ---------- product codes that look like the ones in scope ----------

const squash = (s: string): string => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

export type Lookalike = {
  kind: "sku" | "title";
  alias: string;
  canonicalSku: string;
  lines: number;
  /** How the alias differs from the catalogue code. A description of the text, not a judgement. */
  difference: "punctuation_or_case_only" | "extra_characters" | "code_appears_in_title";
  sampleTitles: string[];
  batchCodes: string[];
  status: "new" | "suggested" | "confirmed" | "rejected";
};

/**
 * Order lines whose product code is NOT one of the SKUs in scope but looks
 * like one. Found by plain text rules, with no AI. These lines are not
 * matched, and stay unmatched until a person confirms an alias.
 */
export async function findLookalikes(q: Queryable, orgId: string, skus: string[]): Promise<Lookalike[]> {
  if (skus.length === 0) return [];
  const scope = skus.map((s) => ({ sku: s.trim(), squashed: squash(s) })).filter((s) => s.squashed.length >= 3);
  const exact = new Set(skus.map((s) => s.trim().toUpperCase()));
  const lines = await q.query<{ sku: string | null; title: string; n: number; batch_codes: string | null }>(
    `select l.sku, l.title, count(distinct l.id)::int as n, string_agg(distinct fl.batch_code, ', ') as batch_codes
       from order_lines l left join fulfilment_lines fl on fl.org_id = l.org_id and fl.order_line_id = l.id
      where l.org_id = $1 group by l.sku, l.title`,
    [orgId],
  );
  const known = await q.query<{ kind: "sku" | "title"; alias_normalized: string; canonical_sku: string; status: Lookalike["status"] }>(
    "select kind, alias_normalized, canonical_sku, status from product_aliases where org_id = $1",
    [orgId],
  );
  const statusOf = (kind: string, normalized: string, canonical: string): Lookalike["status"] =>
    known.find((k) => k.kind === kind && k.alias_normalized === normalized && k.canonical_sku === canonical)?.status ?? "new";

  const found = new Map<string, Lookalike>();
  for (const line of lines) {
    const code = line.sku?.trim() ?? "";
    for (const s of scope) {
      let hit: Pick<Lookalike, "kind" | "alias" | "difference"> | null = null;
      if (code !== "") {
        if (exact.has(code.toUpperCase())) continue;
        const sq = squash(code);
        if (sq === s.squashed) hit = { kind: "sku", alias: code, difference: "punctuation_or_case_only" };
        else if (sq.startsWith(s.squashed) || s.squashed.startsWith(sq)) hit = { kind: "sku", alias: code, difference: "extra_characters" };
      } else if (squash(line.title).includes(s.squashed)) {
        hit = { kind: "title", alias: line.title, difference: "code_appears_in_title" };
      }
      if (!hit) continue;
      const normalized = hit.kind === "sku" ? hit.alias.trim().toUpperCase() : hit.alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const key = `${hit.kind}|${normalized}|${s.sku}`;
      const entry = found.get(key) ?? {
        ...hit, canonicalSku: s.sku, lines: 0, sampleTitles: [], batchCodes: [], status: statusOf(hit.kind, normalized, s.sku),
      };
      entry.lines += line.n;
      if (!entry.sampleTitles.includes(line.title) && entry.sampleTitles.length < 3) entry.sampleTitles.push(line.title);
      for (const b of (line.batch_codes ?? "").split(", ").filter(Boolean)) if (!entry.batchCodes.includes(b)) entry.batchCodes.push(b);
      found.set(key, entry);
    }
  }
  // "HM300" differs from HM-300 only by a hyphen. It is then not also offered as a longer form of HM-300-EU.
  const closest = new Set([...found.values()].filter((f) => f.difference === "punctuation_or_case_only").map((f) => `${f.kind}|${f.alias}`));
  return [...found.values()]
    .filter((f) => f.difference !== "extra_characters" || !closest.has(`${f.kind}|${f.alias}`))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}
