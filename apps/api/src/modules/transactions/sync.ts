// Keeping a local copy of the merchant's PayPal transactions, and working out
// which payment paid for which order.
//
// Source: PayPal Transaction Search (GET /v1/reporting/transactions).
// Limits, from PayPal's specification: at most 31 days per request, three
// years of history, up to three hours before a new transaction appears, and
// 500 rows per page. The sync therefore walks the window in 31-day slices and
// always re-reads the last few hours.

import type { Clock } from "../../platform/clock.ts";
import { DAY } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { toMinor } from "../../platform/money.ts";
import type { PayPalProvider, ProviderEnvironment, ProviderTransaction } from "../paypal/provider.ts";

export type SyncStats = { slices: number; pages: number; payments: number; refunds: number; other: number; skipped: number };

const MAX_SLICE_MS = 31 * DAY - 1000;

/** PayPal transaction event codes: T00xx are payments received, T11xx are refunds and reversals. */
export function classifyTransaction(t: ProviderTransaction): "payment" | "refund" | "other" {
  const code = t.event_code ?? "";
  const negative = t.amount.value.trim().startsWith("-");
  if (code.startsWith("T11")) return "refund";
  if (code.startsWith("T00") && !negative) return "payment";
  return "other";
}

async function upsertTransaction(
  q: Queryable,
  orgId: string,
  connectionId: string,
  environment: ProviderEnvironment,
  t: ProviderTransaction,
  now: Date,
): Promise<"payment" | "refund" | "other" | "skipped"> {
  const kind = classifyTransaction(t);
  const currency = t.amount.currency_code;
  let gross: number;
  let fee: number | null = null;
  try {
    gross = Math.abs(toMinor(t.amount.value, currency));
    if (t.fee) fee = Math.abs(toMinor(t.fee.value, t.fee.currency_code));
  } catch {
    return "skipped"; // an amount PayPal reports in a form we cannot hold exactly
  }
  const items = t.items.map((i) => {
    let unitMinor: number | undefined;
    try {
      unitMinor = i.unit_price ? toMinor(i.unit_price.value, i.unit_price.currency_code) : undefined;
    } catch {
      unitMinor = undefined;
    }
    return { code: i.code, name: i.name, quantity: i.quantity ? Number.parseInt(i.quantity, 10) || undefined : undefined, unitMinor };
  });
  await q.query(
    `insert into payment_transactions
       (org_id, paypal_connection_id, environment, transaction_id, kind, event_code, provider_status, occurred_at,
        provider_updated_at, currency, gross_minor, fee_minor, payer_id, payer_email, payer_email_normalized,
        payer_name, payer_country, invoice_id, custom_id, reference_transaction_id, items, source, raw, last_synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,'transaction_search',$22::jsonb,$23)
     on conflict (org_id, provider, environment, transaction_id) do update set
       kind = excluded.kind, event_code = excluded.event_code, provider_status = excluded.provider_status,
       provider_updated_at = excluded.provider_updated_at, gross_minor = excluded.gross_minor,
       fee_minor = excluded.fee_minor, payer_id = coalesce(excluded.payer_id, payment_transactions.payer_id),
       payer_email = coalesce(excluded.payer_email, payment_transactions.payer_email),
       payer_email_normalized = coalesce(excluded.payer_email_normalized, payment_transactions.payer_email_normalized),
       payer_name = coalesce(excluded.payer_name, payment_transactions.payer_name),
       payer_country = coalesce(excluded.payer_country, payment_transactions.payer_country),
       invoice_id = coalesce(excluded.invoice_id, payment_transactions.invoice_id),
       custom_id = coalesce(excluded.custom_id, payment_transactions.custom_id),
       reference_transaction_id = coalesce(excluded.reference_transaction_id, payment_transactions.reference_transaction_id),
       items = case when jsonb_array_length(excluded.items) > 0 then excluded.items else payment_transactions.items end,
       raw = excluded.raw, last_synced_at = excluded.last_synced_at`,
    [
      orgId, connectionId, environment, t.transaction_id, kind, t.event_code ?? null, t.status ?? null, t.initiated_at,
      t.updated_at ?? null, currency, gross, fee, t.payer?.account_id ?? null, t.payer?.email ?? null,
      t.payer?.email ? t.payer.email.trim().toLowerCase() : null, t.payer?.name ?? null,
      t.payer?.country_code && /^[A-Z]{2}$/.test(t.payer.country_code) ? t.payer.country_code : null,
      t.invoice_id ?? null, t.custom_field ?? null, kind === "refund" ? t.reference_id ?? null : null,
      json(items), json(t.raw), now.toISOString(),
    ],
  );
  return kind;
}

/** Recomputes, from the refund rows we hold, how much of each payment has been refunded. */
export async function recomputeRefundedTotals(q: Queryable, orgId: string): Promise<void> {
  await q.query(
    `update payment_transactions p
        set refunded_minor = least(p.gross_minor, coalesce((
              select sum(r.gross_minor)::bigint from payment_transactions r
               where r.org_id = p.org_id and r.environment = p.environment and r.kind = 'refund'
                 and r.reference_transaction_id = p.transaction_id
                 and coalesce(r.provider_status, 'S') not in ('D', 'V')), 0))
      where p.org_id = $1 and p.kind = 'payment'`,
    [orgId],
  );
}

export async function syncTransactions(
  deps: { db: Db; clock: Clock },
  input: { orgId: string; connectionId: string; provider: PayPalProvider; from: Date; to: Date },
): Promise<SyncStats> {
  const { db, clock } = deps;
  const stats: SyncStats = { slices: 0, pages: 0, payments: 0, refunds: 0, other: 0, skipped: 0 };
  const [run] = await db.query<{ id: string }>(
    `insert into sync_runs (org_id, source, connection_ref, window_start, window_end, started_at)
     values ($1, 'paypal_transactions', $2, $3, $4, $5) returning id`,
    [input.orgId, input.connectionId, input.from.toISOString(), input.to.toISOString(), clock.now().toISOString()],
  );
  try {
    for (let start = input.from.getTime(); start < input.to.getTime(); start += MAX_SLICE_MS) {
      const end = Math.min(start + MAX_SLICE_MS, input.to.getTime());
      stats.slices++;
      for (let page = 1; ; page++) {
        const result = await input.provider.searchTransactions({
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          page,
          pageSize: 500,
        });
        stats.pages++;
        await db.tx(async (tx) => {
          for (const t of result.transactions) {
            const kind = await upsertTransaction(tx, input.orgId, input.connectionId, input.provider.environment, t, clock.now());
            if (kind === "payment") stats.payments++;
            else if (kind === "refund") stats.refunds++;
            else if (kind === "other") stats.other++;
            else stats.skipped++;
          }
        });
        if (page >= result.totalPages) break;
      }
    }
    await db.tx(async (tx) => {
      await recomputeRefundedTotals(tx, input.orgId);
      await linkOrdersToPayments(tx, input.orgId);
      await tx.query("update sync_runs set status = 'succeeded', stats = $2::jsonb, finished_at = $3 where id = $1", [
        run!.id, json(stats), clock.now().toISOString(),
      ]);
    });
    return stats;
  } catch (err) {
    await db.query("update sync_runs set status = 'failed', stats = $2::jsonb, error = $3, finished_at = $4 where id = $1", [
      run!.id, json(stats), err instanceof Error ? err.message : String(err), clock.now().toISOString(),
    ]);
    throw err;
  }
}

/**
 * Fetches, one by one, the PayPal payments that orders name but that we do not
 * hold yet. Transaction Search can be up to three hours behind (and needs its
 * own permission), so a payment made minutes ago is only reachable this way:
 * GET /v2/payments/captures/{id} with the ID the store recorded.
 *
 * The capture record has no payer details and no refunded total. A payment
 * PayPal reports as PARTIALLY_REFUNDED is stored with its status so the amount
 * left is treated as unknown until the next full sync; PayPal itself still
 * refuses any refund above what is left.
 */
export async function lookupPaymentsByReference(
  deps: { db: Db; clock: Clock },
  input: { orgId: string; connectionId: string; provider: PayPalProvider; limit?: number },
): Promise<{ looked: number; found: number; notFound: string[] }> {
  const { db, clock } = deps;
  const orders = await db.query<{ payment_reference: string; placed_at: Date }>(
    `select distinct on (o.payment_reference) o.payment_reference, o.placed_at
       from orders o
      where o.org_id = $1 and o.payment_reference is not null and o.payment_method in ('paypal', 'unknown')
        and not exists (select 1 from payment_transactions p
                         where p.org_id = o.org_id and p.environment = $2 and p.transaction_id = o.payment_reference)
      order by o.payment_reference limit $3`,
    [input.orgId, input.provider.environment, input.limit ?? 500],
  );
  const result = { looked: orders.length, found: 0, notFound: [] as string[] };
  for (const order of orders) {
    let capture;
    try {
      capture = await input.provider.getCapture(order.payment_reference);
    } catch (err) {
      const status = (err as { httpStatus?: number | null }).httpStatus;
      if ((err as { kind?: string }).kind === "rejected" && (status === 404 || status === 422 || status === 400)) {
        result.notFound.push(order.payment_reference);
        continue;
      }
      throw err;
    }
    let gross: number;
    try {
      gross = toMinor(capture.amount.value, capture.amount.currency_code);
    } catch {
      result.notFound.push(order.payment_reference);
      continue;
    }
    await db.query(
      `insert into payment_transactions
         (org_id, paypal_connection_id, environment, transaction_id, kind, provider_status, occurred_at, currency,
          gross_minor, refunded_minor, invoice_id, custom_id, source, raw, last_synced_at)
       values ($1,$2,$3,$4,'payment',$5,$6,$7,$8,$9,$10,$11,'api_lookup',$12::jsonb,$13)
       on conflict (org_id, provider, environment, transaction_id) do update set
         provider_status = excluded.provider_status, last_synced_at = excluded.last_synced_at`,
      [
        input.orgId, input.connectionId, input.provider.environment, capture.id, capture.status,
        capture.create_time ?? new Date(order.placed_at).toISOString(), capture.amount.currency_code, gross,
        capture.status === "REFUNDED" ? gross : 0, capture.invoice_id ?? null, capture.custom_id ?? null,
        json(capture), clock.now().toISOString(),
      ],
    );
    result.found++;
  }
  await db.tx((tx) => linkOrdersToPayments(tx, input.orgId));
  return result;
}

/**
 * Ties orders to PayPal payments.
 *
 *   exact      the store recorded PayPal's payment ID on the order, or the
 *              payment carries the order number as its invoice ID or custom ID.
 *   heuristic  same email, same amount and currency, within ten minutes, and
 *              no other order or payment fits. A guess: flagged, and never
 *              used to move money until a person confirms it.
 *
 * Independently created order records do not correspond to PayPal payments by
 * themselves. An exact link exists only when one system carries the other's ID.
 */
export async function linkOrdersToPayments(q: Queryable, orgId: string): Promise<{ exact: number; heuristic: number }> {
  const exact = await q.query<{ id: string }>(
    `insert into order_payment_links (org_id, order_id, payment_transaction_id, method, strength, detail)
     select o.org_id, o.id, p.id,
            case when o.payment_reference = p.transaction_id then 'store_reference'
                 when p.invoice_id in (o.order_number, o.external_id) then 'invoice_id'
                 else 'custom_id' end,
            'exact',
            case when o.payment_reference = p.transaction_id then 'the store recorded this PayPal payment ID on the order'
                 when p.invoice_id in (o.order_number, o.external_id) then 'the PayPal payment carries the order number as its invoice ID'
                 else 'the PayPal payment carries the order ID as its custom ID' end
       from orders o
       join payment_transactions p
         on p.org_id = o.org_id and p.kind = 'payment'
        and (o.payment_reference = p.transaction_id
             or p.invoice_id in (o.order_number, o.external_id)
             or p.custom_id = o.external_id)
      where o.org_id = $1
     on conflict (org_id, order_id, payment_transaction_id) do nothing
     returning id`,
    [orgId],
  );
  const heuristic = await q.query<{ id: string }>(
    `with pairs as (
       select o.id as order_id, p.id as payment_id,
              count(*) over (partition by o.id) as payments_for_order,
              count(*) over (partition by p.id) as orders_for_payment
         from orders o
         join payment_transactions p
           on p.org_id = o.org_id and p.kind = 'payment'
          and p.currency = o.currency and p.gross_minor = o.total_minor
          and p.payer_email_normalized is not null and p.payer_email_normalized = o.customer_email_normalized
          and p.occurred_at between o.placed_at - interval '10 minutes' and o.placed_at + interval '10 minutes'
        where o.org_id = $1
          and o.payment_method in ('paypal', 'unknown')
          and not exists (select 1 from order_payment_links l where l.org_id = o.org_id and l.order_id = o.id)
          and not exists (select 1 from order_payment_links l where l.org_id = p.org_id and l.payment_transaction_id = p.id))
     insert into order_payment_links (org_id, order_id, payment_transaction_id, method, strength, detail)
     select $1, order_id, payment_id, 'heuristic', 'heuristic',
            'same email, amount and currency, within ten minutes; no ID ties them together'
       from pairs where payments_for_order = 1 and orders_for_payment = 1
     on conflict (org_id, order_id, payment_transaction_id) do nothing
     returning id`,
    [orgId],
  );
  return { exact: exact.length, heuristic: heuristic.length };
}
