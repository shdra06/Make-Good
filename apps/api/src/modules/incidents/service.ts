// Incidents: what went wrong, the versioned rules for who is affected and what
// they are owed, and the match run that turns records into candidates.

import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json, placeholders } from "../../platform/db/db.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import { calculateCompensation, CompensationRule, type CompensationResult } from "../compensation/engine.ts";
import { revalidateOpenBatches } from "../execution/manifests.ts";
import { normSku, normTitle, runMatch } from "../matching/engine.ts";
import {
  IncidentScope,
  type AdjustmentRecord,
  type AliasRecord,
  type CandidateDraft,
  type InventoryBatchRecord,
  type MatchStats,
  type OrderLineRecord,
  type OrderRecord,
  type PaymentRecord,
} from "../matching/types.ts";

export type Deps = { db: Db; clock: Clock };

export const IncidentKind = z.enum([
  "product_defect", "recall", "overcharge", "duplicate_charge", "cancelled_event",
  "subscription_error", "service_disruption", "failed_delivery", "pricing_error", "other",
]);

export const NewIncident = z.object({
  kind: IncidentKind,
  title: z.string().trim().min(3).max(200),
  description: z.string().max(5000).default(""),
});

export const NewRuleVersion = z.object({
  scope: IncidentScope,
  compensation: CompensationRule,
  note: z.string().max(1000).optional(),
});

export async function createIncident(
  deps: Deps,
  input: { orgId: string; userId: string } & z.infer<typeof NewIncident>,
): Promise<{ id: string }> {
  return deps.db.tx(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into incidents (org_id, kind, title, description, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6) returning id`,
      [input.orgId, input.kind, input.title, input.description, input.userId, deps.clock.now().toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "incident.created",
      entityType: "incident", entityId: row!.id, data: { kind: input.kind, title: input.title }, at: deps.clock.now(),
    });
    return { id: row!.id };
  });
}

/** Rules are never edited. Each change is a new version, kept for good. */
export async function addRuleVersion(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string } & z.infer<typeof NewRuleVersion>,
): Promise<{ id: string; version: number }> {
  const saved = await saveRuleVersion(deps, input);
  // An approval given under the old rules no longer covers what would be paid.
  await revalidateOpenBatches(deps, { orgId: input.orgId, incidentId: input.incidentId });
  return saved;
}

async function saveRuleVersion(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string } & z.infer<typeof NewRuleVersion>,
): Promise<{ id: string; version: number }> {
  return deps.db.tx(async (tx) => {
    const incident = await tx.query<{ status: string }>(
      "select status from incidents where org_id = $1 and id = $2 for update",
      [input.orgId, input.incidentId],
    );
    if (!incident[0]) throw new NotFoundError("Incident");
    if (incident[0].status === "closed" || incident[0].status === "cancelled") {
      throw new ConflictError("INCIDENT_CLOSED", "This incident is closed. Its rules can no longer change.");
    }
    const [next] = await tx.query<{ v: number }>(
      "select coalesce(max(version), 0)::int + 1 as v from incident_rule_versions where org_id = $1 and incident_id = $2",
      [input.orgId, input.incidentId],
    );
    const [row] = await tx.query<{ id: string }>(
      `insert into incident_rule_versions (org_id, incident_id, version, scope, compensation, note, created_by, created_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) returning id`,
      [input.orgId, input.incidentId, next!.v, json(input.scope), json(input.compensation), input.note ?? null, input.userId, deps.clock.now().toISOString()],
    );
    await tx.query("update incidents set status = 'active', updated_at = $3 where org_id = $1 and id = $2 and status = 'draft'", [
      input.orgId, input.incidentId, deps.clock.now().toISOString(),
    ]);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "incident.rules_versioned",
      entityType: "incident", entityId: input.incidentId,
      data: { ruleVersionId: row!.id, version: next!.v, scope: input.scope, compensation: input.compensation }, at: deps.clock.now(),
    });
    return { id: row!.id, version: next!.v };
  });
}

export type RuleVersion = { id: string; version: number; scope: IncidentScope; compensation: CompensationRule };

export async function latestRuleVersion(q: Queryable, orgId: string, incidentId: string): Promise<RuleVersion | null> {
  const rows = await q.query<{ id: string; version: number; scope: unknown; compensation: unknown }>(
    `select id, version, scope, compensation from incident_rule_versions
      where org_id = $1 and incident_id = $2 order by version desc limit 1`,
    [orgId, incidentId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, version: row.version, scope: IncidentScope.parse(row.scope), compensation: CompensationRule.parse(row.compensation) };
}

// ---------- loading records for the engines ----------

type OrderRow = {
  id: string; order_number: string; channel: string; placed_at: Date; currency: string; customer_email: string | null;
  customer_name: string | null; is_guest: boolean; payment_method: OrderRecord["paymentMethod"]; subtotal_minor: number;
  discount_minor: number; shipping_minor: number; tax_minor: number; total_minor: number; status: string;
};
type PaymentRow = {
  id: string; transaction_id: string; occurred_at: Date; currency: string; gross_minor: number; refunded_minor: number;
  payer_id: string | null; payer_email: string | null; payer_name: string | null; payer_country: string | null;
  invoice_id: string | null; custom_id: string | null; items: PaymentRecord["items"]; dispute_state: "open" | "resolved" | null;
};

const PAYMENT_COLUMNS = `id, transaction_id, occurred_at, trim(currency) as currency, gross_minor, refunded_minor, payer_id,
  payer_email, payer_name, payer_country, invoice_id, custom_id, items, dispute_state`;

const toPayment = (r: PaymentRow): PaymentRecord => ({
  id: r.id, transactionId: r.transaction_id, occurredAt: new Date(r.occurred_at), currency: r.currency,
  grossMinor: r.gross_minor, refundedMinor: r.refunded_minor, payerId: r.payer_id, payerEmail: r.payer_email,
  payerName: r.payer_name, payerCountry: r.payer_country, invoiceId: r.invoice_id, customId: r.custom_id,
  items: Array.isArray(r.items) ? r.items : [], disputeState: r.dispute_state,
});

/** The same ranking the matching engine uses for kinds of order-to-payment link. */
const LINK_RANK_SQL = (column: string): string =>
  `(case ${column} when 'manual' then 3 when 'store_reference' then 2 when 'heuristic' then 0 else 1 end)`;

async function chunked<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(await fn(ids.slice(i, i + 500))));
  return out;
}

/** Loads full order records (lines, fulfilments, adjustments, payment links) for the given order IDs. */
export async function loadOrders(q: Queryable, orgId: string, orderIds: string[]): Promise<OrderRecord[]> {
  if (orderIds.length === 0) return [];
  const orders = await chunked(orderIds, (ids) =>
    q.query<OrderRow>(
      `select id, order_number, channel, placed_at, trim(currency) as currency, customer_email, customer_name, is_guest,
              payment_method, subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, status
         from orders where org_id = $1 and id in (${placeholders(ids.length, 1)})`,
      [orgId, ...ids],
    ),
  );
  const lines = await chunked(orderIds, (ids) =>
    q.query<{
      id: string; order_id: string; sku: string | null; variant_id: string | null; title: string; kind: OrderLineRecord["kind"];
      quantity: number; unit_price_minor: number; discount_minor: number; tax_minor: number; parent_line_id: string | null;
      service_start: Date | null; service_end: Date | null;
    }>(
      `select id, order_id, sku, variant_id, title, kind, quantity, unit_price_minor, discount_minor, tax_minor,
              parent_line_id, service_start, service_end
         from order_lines where org_id = $1 and order_id in (${placeholders(ids.length, 1)}) order by position, id`,
      [orgId, ...ids],
    ),
  );
  const fulfilments = await chunked(orderIds, (ids) =>
    q.query<{ id: string; fulfilment_id: string; order_line_id: string; quantity: number; batch_code: string | null; serials: string[]; shipped_at: Date | null; warehouse: string }>(
      `select fl.id, fl.fulfilment_id, fl.order_line_id, fl.quantity, fl.batch_code, fl.serials, f.shipped_at, f.warehouse
         from fulfilment_lines fl join fulfilments f on f.org_id = fl.org_id and f.id = fl.fulfilment_id
        where fl.org_id = $1 and f.order_id in (${placeholders(ids.length, 1)})`,
      [orgId, ...ids],
    ),
  );
  const adjustments = await chunked(orderIds, (ids) =>
    q.query<{ id: string; order_id: string; order_line_id: string | null; kind: AdjustmentRecord["kind"]; quantity: number; amount_minor: number; occurred_at: Date }>(
      `select id, order_id, order_line_id, kind, quantity, amount_minor, occurred_at
         from order_adjustments where org_id = $1 and order_id in (${placeholders(ids.length, 1)})`,
      [orgId, ...ids],
    ),
  );
  const links = await chunked(orderIds, (ids) =>
    q.query<{ order_id: string; payment_transaction_id: string; method: OrderRecord["paymentLinks"][number]["method"]; strength: "exact" | "heuristic"; detail: string; rival_orders: number }>(
      `select l.order_id, l.payment_transaction_id, l.method, l.strength, l.detail,
              -- other orders tied to the same payment by a link at least as strong as this one
              (select count(*)::int from order_payment_links r
                where r.org_id = l.org_id and r.payment_transaction_id = l.payment_transaction_id and r.order_id <> l.order_id
                  and ${LINK_RANK_SQL("r.method")} >= ${LINK_RANK_SQL("l.method")}) as rival_orders
         from order_payment_links l where l.org_id = $1 and l.order_id in (${placeholders(ids.length, 1)})`,
      [orgId, ...ids],
    ),
  );

  const toAdjustment = (a: (typeof adjustments)[number]): AdjustmentRecord => ({
    id: a.id, kind: a.kind, quantity: a.quantity, amountMinor: a.amount_minor, occurredAt: new Date(a.occurred_at),
  });
  return orders.map((o): OrderRecord => ({
    id: o.id, orderNumber: o.order_number, channel: o.channel, placedAt: new Date(o.placed_at), currency: o.currency,
    customerEmail: o.customer_email, customerName: o.customer_name, isGuest: o.is_guest, paymentMethod: o.payment_method,
    subtotalMinor: o.subtotal_minor, discountMinor: o.discount_minor, shippingMinor: o.shipping_minor, taxMinor: o.tax_minor,
    totalMinor: o.total_minor, status: o.status,
    lines: lines.filter((l) => l.order_id === o.id).map((l): OrderLineRecord => ({
      id: l.id, sku: l.sku, variantId: l.variant_id, title: l.title, kind: l.kind, quantity: l.quantity,
      unitPriceMinor: l.unit_price_minor, discountMinor: l.discount_minor, taxMinor: l.tax_minor,
      parentLineId: l.parent_line_id,
      serviceStart: l.service_start ? new Date(l.service_start) : null,
      serviceEnd: l.service_end ? new Date(l.service_end) : null,
      fulfilments: fulfilments.filter((f) => f.order_line_id === l.id).map((f) => ({
        id: f.id, fulfilmentId: f.fulfilment_id, quantity: f.quantity, shippedAt: f.shipped_at ? new Date(f.shipped_at) : null,
        warehouse: f.warehouse, batchCode: f.batch_code, serials: Array.isArray(f.serials) ? f.serials : [],
      })),
      adjustments: adjustments.filter((a) => a.order_line_id === l.id).map(toAdjustment),
    })),
    adjustments: adjustments.filter((a) => a.order_id === o.id && a.order_line_id === null).map(toAdjustment),
    paymentLinks: links.filter((l) => l.order_id === o.id).map((l) => ({
      paymentId: l.payment_transaction_id, method: l.method, strength: l.strength, detail: l.detail, rivalOrders: l.rival_orders,
    })),
  }));
}

export async function loadPayments(q: Queryable, orgId: string, paymentIds: string[]): Promise<PaymentRecord[]> {
  if (paymentIds.length === 0) return [];
  const rows = await chunked(paymentIds, (ids) =>
    q.query<PaymentRow>(
      `select ${PAYMENT_COLUMNS} from payment_transactions where org_id = $1 and id in (${placeholders(ids.length, 1)})`,
      [orgId, ...ids],
    ),
  );
  return rows.map(toPayment);
}

/** The most unlinked payments a single match will look at. More than this is reported, not silently dropped. */
const UNLINKED_PAYMENT_LIMIT = 5000;

/** Aliases a person has confirmed for the SKUs in scope. Suggested or rejected aliases change nothing. */
export async function confirmedAliases(q: Queryable, orgId: string, skus: string[]): Promise<AliasRecord[]> {
  if (skus.length === 0) return [];
  const rows = await q.query<{ id: string; kind: "sku" | "title"; alias: string; canonical_sku: string; confirmed_by: string | null }>(
    `select a.id, a.kind, a.alias, a.canonical_sku, u.name as confirmed_by
       from product_aliases a left join users u on u.id = a.decided_by
      where a.org_id = $1 and a.status = 'confirmed' and upper(trim(a.canonical_sku)) in (${placeholders(skus.length, 1)})`,
    [orgId, ...skus],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, alias: r.alias, canonicalSku: r.canonical_sku, confirmedBy: r.confirmed_by }));
}

export async function loadMatchData(
  q: Queryable,
  orgId: string,
  scope: IncidentScope,
): Promise<{ orders: OrderRecord[]; payments: PaymentRecord[]; batches: InventoryBatchRecord[]; aliases: AliasRecord[]; truncated: boolean }> {
  let orderIds: string[] = [];
  let extraPayments: PaymentRecord[] = [];
  let batches: InventoryBatchRecord[] = [];
  let aliases: AliasRecord[] = [];
  let truncated = false;

  if (scope.type === "duplicate_charge") {
    const rows = await q.query<PaymentRow>(
      `select ${PAYMENT_COLUMNS} from payment_transactions
        where org_id = $1 and kind = 'payment' and occurred_at between $2 and $3 order by occurred_at`,
      [orgId, scope.from, scope.to],
    );
    extraPayments = rows.map(toPayment);
    const linked = await chunked(extraPayments.map((p) => p.id), (ids) =>
      q.query<{ order_id: string }>(
        `select distinct order_id from order_payment_links where org_id = $1 and payment_transaction_id in (${placeholders(ids.length, 1)})`,
        [orgId, ...ids],
      ),
    );
    orderIds = [...new Set(linked.map((l) => l.order_id))];
  } else {
    const skus = (scope.type === "overcharge" ? [scope.sku] : scope.skus).map(normSku);
    // Only product incidents use aliases: a recall of HM-300 should reach an order line written "HM300".
    if (scope.type === "product") aliases = await confirmedAliases(q, orgId, skus);
    const codes = [...new Set([...skus, ...aliases.filter((a) => a.kind === "sku").map((a) => normSku(a.alias))])];
    const titles = [...new Set(aliases.filter((a) => a.kind === "title").map((a) => normTitle(a.alias)))];
    const params: unknown[] = [orgId, ...codes];
    let titleClause = "";
    if (titles.length > 0) {
      titleClause = ` or (coalesce(trim(l.sku), '') = '' and trim(regexp_replace(lower(l.title), '[^a-z0-9]+', ' ', 'g')) in (${placeholders(titles.length, params.length)}))`;
      params.push(...titles);
    }
    let window = "";
    const from = scope.type === "product" ? scope.orderedFrom : scope.type === "overcharge" ? scope.from : null;
    const to = scope.type === "product" ? scope.orderedTo : scope.type === "overcharge" ? scope.to : null;
    if (from) {
      params.push(from);
      window += ` and o.placed_at >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      window += ` and o.placed_at <= $${params.length}`;
    }
    const rows = await q.query<{ id: string }>(
      `select o.id from orders o
        where o.org_id = $1 ${window}
          and exists (select 1 from order_lines l
                       where l.org_id = o.org_id and l.order_id = o.id
                         and (upper(trim(l.sku)) in (${placeholders(codes.length, 1)})${titleClause}))`,
      params,
    );
    orderIds = rows.map((r) => r.id);

    if (scope.type === "product") {
      const batchRows = await q.query<{
        id: string; variant_id: string; sku: string; batch_code: string; warehouse: string;
        received_at: Date | null; first_shipped_at: Date | null; last_shipped_at: Date | null;
      }>(
        `select b.id, b.variant_id, v.sku, b.batch_code, b.warehouse, b.received_at, b.first_shipped_at, b.last_shipped_at
           from inventory_batches b join product_variants v on v.org_id = b.org_id and v.id = b.variant_id
          where b.org_id = $1 and upper(trim(v.sku)) in (${placeholders(skus.length, 1)})`,
        [orgId, ...skus],
      );
      batches = batchRows.map((b) => ({
        id: b.id, variantId: b.variant_id, sku: b.sku, batchCode: b.batch_code, warehouse: b.warehouse,
        receivedAt: b.received_at ? new Date(b.received_at) : null,
        firstShippedAt: b.first_shipped_at ? new Date(b.first_shipped_at) : null,
        lastShippedAt: b.last_shipped_at ? new Date(b.last_shipped_at) : null,
      }));
      // Payments with no order behind them, so a customer missing from the store export is still seen.
      const unlinkedParams: unknown[] = [orgId];
      let unlinkedWindow = "";
      if (scope.orderedFrom) {
        unlinkedParams.push(scope.orderedFrom);
        unlinkedWindow += ` and p.occurred_at >= $${unlinkedParams.length}`;
      }
      if (scope.orderedTo) {
        unlinkedParams.push(scope.orderedTo);
        unlinkedWindow += ` and p.occurred_at <= $${unlinkedParams.length}`;
      }
      const unlinked = await q.query<PaymentRow>(
        `select ${PAYMENT_COLUMNS} from payment_transactions p
          where p.org_id = $1 and p.kind = 'payment' ${unlinkedWindow}
            and not exists (select 1 from order_payment_links l where l.org_id = p.org_id and l.payment_transaction_id = p.id)
          order by p.occurred_at limit ${UNLINKED_PAYMENT_LIMIT + 1}`,
        unlinkedParams,
      );
      truncated = unlinked.length > UNLINKED_PAYMENT_LIMIT;
      extraPayments = unlinked.slice(0, UNLINKED_PAYMENT_LIMIT).map(toPayment);
    }
  }

  const orders = await loadOrders(q, orgId, orderIds);
  const linkedIds = [...new Set(orders.flatMap((o) => o.paymentLinks.map((l) => l.paymentId)))];
  const known = new Set(extraPayments.map((p) => p.id));
  const linkedPayments = await loadPayments(q, orgId, linkedIds.filter((id) => !known.has(id)));
  return { orders, payments: [...extraPayments, ...linkedPayments], batches, aliases, truncated };
}

// ---------- the match run ----------

export type MatchRunResult = {
  matchRunId: string;
  ruleVersionId: string;
  stats: MatchStats;
  /** Affected, held and excluded records. Buyers shown not to be affected are counted in `cleared`. */
  candidates: number;
  autoConfirmed: number;
  needConfirmation: number;
  excluded: number;
  cleared: number;
  /** How many records fell into each next step. */
  byDecision: Record<string, number>;
  truncated: boolean;
  /** Batches whose approval no longer covers what would be paid, after this run. */
  invalidatedBatches: string[];
};

function statusFor(draft: CandidateDraft): "proposed" | "confirmed" | "excluded" | "cleared" {
  if (draft.status === "excluded" || draft.status === "cleared") return draft.status;
  // Verified payment and proven eligibility: no per-customer decision is needed.
  // This only makes the record eligible for a batch. The batch approval is the human control.
  return draft.needsConfirmation ? "proposed" : "confirmed";
}

/** Evidence written by people is kept when the engine runs again. Everything else is rebuilt. */
const HUMAN_EVIDENCE = "('reviewer', 'customer_statement', 'claim_evidence')";

export async function storeCalculation(
  tx: Queryable,
  input: { orgId: string; candidateId: string; ruleVersionId: string; result: CompensationResult; now: Date },
): Promise<string> {
  const { result } = input;
  const current = await tx.query<{ id: string; inputs_hash: string }>(
    "select id, inputs_hash from compensation_calculations where org_id = $1 and candidate_id = $2 and is_current",
    [input.orgId, input.candidateId],
  );
  if (current[0]?.inputs_hash === result.inputsHash) return current[0].id;
  if (current[0]) {
    await tx.query("update compensation_calculations set is_current = false where org_id = $1 and id = $2", [input.orgId, current[0].id]);
  }
  const [row] = await tx.query<{ id: string }>(
    `insert into compensation_calculations
       (org_id, candidate_id, rule_version_id, currency, entitlement_minor, already_refunded_minor, payable_minor,
        route, route_reason, steps, inputs_hash, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) returning id`,
    [
      input.orgId, input.candidateId, input.ruleVersionId, result.currency, result.entitlementMinor,
      result.alreadyRefundedMinor, result.payableMinor, result.route, result.routeReason,
      json({ steps: result.steps, recipient: result.recipient }), result.inputsHash, input.now.toISOString(),
    ],
  );
  return row!.id;
}

/**
 * Runs the matching engine for an incident's latest rules and stores the
 * result. Safe to run again: candidates keep their identity (subject key), a
 * person's earlier decision is kept, and amounts are recalculated.
 *
 * Afterwards, any batch not yet started is checked against the new result.
 * If what it would pay has changed, its approval is withdrawn.
 */
export async function runIncidentMatch(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string | null; payoutsAvailable: boolean },
): Promise<MatchRunResult> {
  const result = await storeMatch(deps, input);
  result.invalidatedBatches = await revalidateOpenBatches(deps, { orgId: input.orgId, incidentId: input.incidentId });
  return result;
}

async function storeMatch(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string | null; payoutsAvailable: boolean },
): Promise<MatchRunResult> {
  const { db, clock } = deps;
  const rules = await latestRuleVersion(db, input.orgId, input.incidentId);
  if (!rules) throw new ValidationError("This incident has no rules yet. Add a scope and a compensation rule first.");
  const data = await loadMatchData(db, input.orgId, rules.scope);
  const now = clock.now();
  const output = runMatch({ scope: rules.scope, now, orders: data.orders, payments: data.payments, batches: data.batches, aliases: data.aliases });
  const ordersById = new Map(data.orders.map((o) => [o.id, o]));
  const paymentsById = new Map(data.payments.map((p) => [p.id, p]));

  return db.tx(async (tx) => {
    const [run] = await tx.query<{ id: string }>(
      `insert into match_runs (org_id, incident_id, rule_version_id, stats, started_at, finished_at)
       values ($1, $2, $3, $4::jsonb, $5, $5) returning id`,
      [input.orgId, input.incidentId, rules.id, json(output.stats), now.toISOString()],
    );
    const result: MatchRunResult = {
      matchRunId: run!.id, ruleVersionId: rules.id, stats: output.stats, candidates: output.candidates.length,
      autoConfirmed: 0, needConfirmation: 0, excluded: 0, cleared: 0, byDecision: {}, truncated: data.truncated,
      invalidatedBatches: [],
    };

    for (const draft of [...output.candidates, ...output.cleared]) {
      const status = statusFor(draft);
      const [row] = await tx.query<{ id: string; status: string }>(
        `insert into candidates
           (org_id, incident_id, rule_version_id, match_run_id, subject_key, order_id, order_line_id,
            payment_transaction_id, customer_email, customer_name, affected_quantity, classification,
            needs_confirmation, status, exclusion_code, reasons, missing, facts, recommended_action,
            payment_identity, eligibility, decision, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$23)
         on conflict (org_id, incident_id, subject_key) do update set
           rule_version_id = excluded.rule_version_id, match_run_id = excluded.match_run_id,
           order_id = excluded.order_id, order_line_id = excluded.order_line_id,
           payment_transaction_id = excluded.payment_transaction_id, customer_email = excluded.customer_email,
           customer_name = excluded.customer_name, affected_quantity = excluded.affected_quantity,
           classification = excluded.classification, needs_confirmation = excluded.needs_confirmation,
           exclusion_code = excluded.exclusion_code, reasons = excluded.reasons, missing = excluded.missing,
           facts = excluded.facts, recommended_action = excluded.recommended_action,
           payment_identity = excluded.payment_identity, eligibility = excluded.eligibility, decision = excluded.decision,
           updated_at = excluded.updated_at,
           -- A person's decision stands, unless the records now rule the candidate out.
           status = case when candidates.decided_by is not null and excluded.status not in ('excluded', 'cleared')
                         then candidates.status else excluded.status end
         returning id, status`,
        [
          input.orgId, input.incidentId, rules.id, run!.id, draft.subjectKey, draft.orderId, draft.orderLineId,
          draft.paymentId, tx.pii.seal(draft.customerEmail), tx.pii.seal(draft.customerName), draft.affectedQuantity, draft.classification,
          draft.needsConfirmation, status, draft.exclusionCode, json(draft.reasons), json(draft.missing),
          json(draft.facts), draft.recommendedAction, draft.paymentIdentity, draft.eligibility, draft.decision,
          now.toISOString(),
        ],
      );
      const candidateId = row!.id;
      result.byDecision[draft.decision] = (result.byDecision[draft.decision] ?? 0) + 1;
      if (row!.status === "excluded") result.excluded++;
      else if (row!.status === "cleared") result.cleared++;
      else if (row!.status === "confirmed") result.autoConfirmed++;
      else if (row!.status === "proposed") result.needConfirmation++;

      await tx.query(`delete from match_evidence where org_id = $1 and candidate_id = $2 and source not in ${HUMAN_EVIDENCE}`, [input.orgId, candidateId]);
      for (const e of draft.evidence) {
        await tx.query(
          `insert into match_evidence (org_id, candidate_id, source, record_id, fact, strength, dimension, kind, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [input.orgId, candidateId, e.source, e.recordId, e.fact, e.strength, e.dimension, e.kind, now.toISOString()],
        );
      }

      if (draft.status !== "proposed") {
        await tx.query("update compensation_calculations set is_current = false where org_id = $1 and candidate_id = $2 and is_current", [
          input.orgId, candidateId,
        ]);
        continue;
      }
      const order = draft.orderId ? ordersById.get(draft.orderId) ?? null : null;
      const calculation = calculateCompensation({
        rule: rules.compensation,
        now,
        candidate: draft,
        order,
        line: order && draft.orderLineId ? order.lines.find((l) => l.id === draft.orderLineId) ?? null : null,
        payment: draft.paymentId ? paymentsById.get(draft.paymentId) ?? null : null,
        payoutsAvailable: input.payoutsAvailable,
      });
      await storeCalculation(tx, { orgId: input.orgId, candidateId, ruleVersionId: rules.id, result: calculation, now });
    }

    // Candidates from an earlier run that the records no longer support, and that nobody has decided on.
    await tx.query(
      `update candidates set status = 'excluded', exclusion_code = 'no_longer_matched', decision = 'excluded', updated_at = $4
        where org_id = $1 and incident_id = $2 and match_run_id is distinct from $3 and claim_id is null
          and decided_by is null and status in ('proposed', 'confirmed')
          and not exists (select 1 from payment_operations op
                           where op.org_id = candidates.org_id and op.candidate_id = candidates.id
                             and op.state in ('queued','submitting','unknown','pending_provider','succeeded'))`,
      [input.orgId, input.incidentId, run!.id, now.toISOString()],
    );
    // "Not affected" rows are a picture of the latest run only.
    await tx.query(
      "delete from candidates where org_id = $1 and incident_id = $2 and status = 'cleared' and match_run_id is distinct from $3",
      [input.orgId, input.incidentId, run!.id],
    );
    await audit(tx, {
      orgId: input.orgId, actor: input.userId ? { kind: "user", userId: input.userId } : { kind: "system" },
      action: "incident.matched", entityType: "incident", entityId: input.incidentId,
      data: { matchRunId: run!.id, ruleVersionId: rules.id, stats: output.stats, byDecision: result.byDecision, truncated: data.truncated }, at: now,
    });
    return result;
  });
}

// ---------- decisions made by people ----------

/** Why a person confirmed a record the engine could not settle on its own. Stored and shown on the approval manifest. */
export const DecisionBasis = z.enum([
  "customer_confirmed_unit", // the customer read the batch code or serial number off the product
  "merchant_records_checked", // staff checked records we do not hold (a warehouse sheet, a courier manifest)
  "policy_include_unproven", // the merchant chose to compensate without proof; an accepted cost, not a finding
  "cross_incident_reviewed", // the customer was paid under another incident for the same order line, and this is a separate harm
]);
export type DecisionBasis = z.infer<typeof DecisionBasis>;

const BASIS_TEXT: Record<DecisionBasis, string> = {
  customer_confirmed_unit: "the customer confirmed the batch code or serial number on the product",
  merchant_records_checked: "staff checked records outside this system",
  policy_include_unproven: "the merchant chose to compensate without proof of the unit",
  cross_incident_reviewed: "staff reviewed an earlier payment under another incident and judged this a separate harm",
};

export type DecideResult = { changed: number; refused: Array<{ candidateId: string; why: string }> };

/**
 * A person at the merchant confirms or declines records that needed a
 * decision. Two things a confirmation can never do:
 *   - settle which PayPal payment paid for an order (use `reconcilePayment`);
 *   - change a record whose payment is already on its way.
 * What the person relied on is stored as evidence, in their name.
 */
export async function decideCandidates(
  deps: Deps,
  input: {
    orgId: string; incidentId: string; userId: string; candidateIds: string[]; decision: "confirm" | "decline";
    basis?: DecisionBasis; note?: string;
  },
): Promise<DecideResult> {
  if (input.candidateIds.length === 0) return { changed: 0, refused: [] };
  const now = deps.clock.now();
  const result = await deps.db.tx(async (tx): Promise<DecideResult> => {
    const rows = await tx.query<{ id: string; status: string; payment_identity: string; eligibility: string; decision: string; busy: boolean }>(
      `select c.id, c.status, c.payment_identity, c.eligibility, c.decision,
              exists (select 1 from payment_operations op
                       where op.org_id = c.org_id and op.candidate_id = c.id
                         and op.state in ('queued','submitting','unknown','pending_provider','succeeded')) as busy
         from candidates c
        where c.org_id = $1 and c.incident_id = $2 and c.id in (${placeholders(input.candidateIds.length, 2)})
        for update`,
      [input.orgId, input.incidentId, ...input.candidateIds],
    );
    const [who] = await tx.query<{ name: string }>("select name from users where id = $1", [input.userId]);
    const refused: DecideResult["refused"] = [];
    const accepted: string[] = [];
    for (const c of rows) {
      if (c.busy) refused.push({ candidateId: c.id, why: "A payment for this record is already in progress or complete." });
      else if (!["proposed", "confirmed", "declined"].includes(c.status)) {
        refused.push({ candidateId: c.id, why: `This record is ${c.status === "cleared" ? "shown not to be affected" : c.status}. Change the records or the rules instead.` });
      } else if (input.decision === "confirm" && (c.payment_identity === "ambiguous" || c.payment_identity === "missing")) {
        refused.push({ candidateId: c.id, why: "It is not settled which PayPal payment paid for this order. Reconcile the payment first." });
      } else accepted.push(c.id);
    }
    if (accepted.length > 0) {
      await tx.query(
        `update candidates set status = $3, decided_by = $4, decided_at = $5, updated_at = $5, decision_basis = $6, decision_note = $7
          where org_id = $1 and incident_id = $2 and id in (${placeholders(accepted.length, 7)})`,
        [input.orgId, input.incidentId, input.decision === "confirm" ? "confirmed" : "declined", input.userId, now.toISOString(),
         input.basis ?? null, input.note ?? null, ...accepted],
      );
      const basis = input.basis ? BASIS_TEXT[input.basis] : "no basis was recorded";
      const fact = `${who?.name ?? "A member of staff"} ${input.decision === "confirm" ? "confirmed" : "declined"} this record on ${now.toISOString().slice(0, 10)}: ${basis}.${input.note ? ` Note: ${input.note}` : ""}`;
      for (const id of accepted) {
        await tx.query(
          `insert into match_evidence (org_id, candidate_id, source, record_id, fact, strength, dimension, kind, created_at)
           values ($1, $2, $3, $4, $5, $6, 'eligibility', $7, $8)`,
          [
            input.orgId, id, input.basis === "customer_confirmed_unit" ? "customer_statement" : "reviewer", input.userId, fact,
            input.decision === "decline" ? "contradicts" : input.basis === "customer_confirmed_unit" ? "proves" : "supports",
            // A choice to pay without proof is recorded as what it is.
            input.basis === "customer_confirmed_unit" || input.basis === "merchant_records_checked" ? "fact" : "assumption",
            now.toISOString(),
          ],
        );
      }
    }
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `candidates.${input.decision}`,
      entityType: "incident", entityId: input.incidentId,
      data: { candidateIds: accepted, refused, basis: input.basis ?? null, note: input.note ?? null }, at: now,
    });
    return { changed: accepted.length, refused };
  });
  if (result.changed > 0) await revalidateOpenBatches(deps, { orgId: input.orgId, incidentId: input.incidentId });
  return result;
}

/**
 * A named person settles which PayPal payment paid for an order. This is the
 * only way an ambiguous or missing payment identity becomes verified. The
 * statement is stored as a link in their name; the match must be run again
 * for it to take effect.
 */
export async function reconcilePayment(
  deps: Deps,
  input: { orgId: string; candidateId: string; paymentTransactionId: string; userId: string; note: string },
): Promise<{ incidentId: string; orderId: string }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [candidate] = await tx.query<{ incident_id: string; order_id: string | null; order_number: string | null; currency: string | null }>(
      `select c.incident_id, c.order_id, o.order_number, trim(o.currency) as currency
         from candidates c left join orders o on o.org_id = c.org_id and o.id = c.order_id
        where c.org_id = $1 and c.id = $2 for update of c`,
      [input.orgId, input.candidateId],
    );
    if (!candidate) throw new NotFoundError("Customer record");
    if (!candidate.order_id) {
      throw new ConflictError("NO_ORDER", "This record is a PayPal payment with no store order. Import the order first; a payment cannot be tied to an order that is not here.");
    }
    const [payment] = await tx.query<{ id: string; transaction_id: string; currency: string; kind: string }>(
      "select id, transaction_id, trim(currency) as currency, kind from payment_transactions where org_id = $1 and id = $2",
      [input.orgId, input.paymentTransactionId],
    );
    if (!payment || payment.kind !== "payment") throw new NotFoundError("PayPal payment");
    if (payment.currency !== candidate.currency) {
      throw new ConflictError("CURRENCY_MISMATCH", `That payment is in ${payment.currency} and the order is in ${candidate.currency}.`);
    }
    const [who] = await tx.query<{ name: string }>("select name from users where id = $1", [input.userId]);
    const detail = `${who?.name ?? "a member of staff"} confirmed it on ${now.toISOString().slice(0, 10)}${input.note ? `: ${input.note}` : ""}`;
    await tx.query(
      `insert into order_payment_links (org_id, order_id, payment_transaction_id, method, strength, detail, created_by, note)
       values ($1, $2, $3, 'manual', 'exact', $4, $5, $6)
       on conflict (org_id, order_id, payment_transaction_id) do update set
         method = 'manual', strength = 'exact', detail = excluded.detail, created_by = excluded.created_by, note = excluded.note`,
      [input.orgId, candidate.order_id, payment.id, detail, input.userId, input.note],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "payment.reconciled",
      entityType: "order", entityId: candidate.order_id,
      data: { candidateId: input.candidateId, orderNumber: candidate.order_number, paymentTransactionId: payment.id, captureId: payment.transaction_id, note: input.note },
      at: now,
    });
    return { incidentId: candidate.incident_id, orderId: candidate.order_id };
  });
}
