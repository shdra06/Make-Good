// The recall on one time line: when each batch was in stock and shipping,
// where batches overlapped (mixed stock), when each buyer's order shipped, and
// how long PayPal still allows a refund of their payment.
//
// Read only. It explains the two answers the matching engine already stored;
// it never changes a record, so nothing on the screen can move money.

import type { Queryable } from "../../platform/db/db.ts";
import { NotFoundError } from "../../platform/errors.ts";
import { latestRuleVersion } from "../incidents/service.ts";
import { normCode, normSku } from "../matching/engine.ts";
import { DISPOSITION_SQL, DISPOSITION_TEXT, MAP_FROM, type Disposition } from "./map.ts";

/** PayPal refunds a captured payment for 180 days (developer.paypal.com/docs/api/payments/v2, captures refund). */
export const PAYPAL_REFUND_WINDOW_DAYS = 180;
/** A refund window with this many days or fewer left is shown as closing soon. */
export const CLOSING_SOON_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

export type DeadlineState = "open" | "closing_soon" | "closed" | "no_paypal_payment";

export type TimelineBatch = {
  id: string;
  sku: string;
  batchCode: string;
  warehouse: string;
  quantity: number | null;
  receivedAt: string | null;
  firstShippedAt: string | null;
  lastShippedAt: string | null;
  /** Named as affected by the incident's rules. */
  affected: boolean;
};

export type MixedStockWindow = {
  sku: string;
  warehouse: string;
  from: string;
  to: string;
  affectedBatch: string;
  otherBatch: string;
};

export type TimelineRecord = {
  candidateId: string;
  orderNumber: string | null;
  customerName: string | null;
  sku: string | null;
  quantity: number;
  placedAt: string | null;
  shippedAt: string | null;
  warehouse: string | null;
  /** Batch codes written at packing, if any. */
  recordedBatches: string[];
  paymentIdentity: string;
  eligibility: string;
  disposition: Disposition;
  dispositionLabel: string;
  paidAt: string | null;
  refundDeadline: string | null;
  daysLeft: number | null;
  deadline: DeadlineState;
};

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

/** Days in which an affected batch and another batch of the same product were both leaving the same warehouse. */
export function mixedStockWindows(batches: TimelineBatch[]): MixedStockWindow[] {
  const out: MixedStockWindow[] = [];
  for (const a of batches) {
    if (!a.affected || !a.firstShippedAt || !a.lastShippedAt) continue;
    for (const b of batches) {
      if (b.affected || b.sku !== a.sku || b.warehouse !== a.warehouse || !b.firstShippedAt || !b.lastShippedAt) continue;
      const from = Math.max(Date.parse(a.firstShippedAt), Date.parse(b.firstShippedAt));
      const to = Math.min(Date.parse(a.lastShippedAt), Date.parse(b.lastShippedAt));
      if (from <= to) {
        out.push({ sku: a.sku, warehouse: a.warehouse, from: new Date(from).toISOString(), to: new Date(to).toISOString(), affectedBatch: a.batchCode, otherBatch: b.batchCode });
      }
    }
  }
  return out.sort((x, y) => x.from.localeCompare(y.from) || x.affectedBatch.localeCompare(y.affectedBatch));
}

/** Where a payment stands against PayPal's refund window on a given day. */
export function refundDeadline(paidAt: Date | null, now: Date): { refundDeadline: string | null; daysLeft: number | null; deadline: DeadlineState } {
  if (!paidAt) return { refundDeadline: null, daysLeft: null, deadline: "no_paypal_payment" };
  const end = new Date(paidAt.getTime() + PAYPAL_REFUND_WINDOW_DAYS * DAY);
  const daysLeft = Math.floor((end.getTime() - now.getTime()) / DAY);
  const deadline: DeadlineState = end.getTime() <= now.getTime() ? "closed" : daysLeft <= CLOSING_SOON_DAYS ? "closing_soon" : "open";
  return { refundDeadline: end.toISOString(), daysLeft, deadline };
}

export async function recallTimeline(q: Queryable, orgId: string, incidentId: string, now: Date) {
  const [incident] = await q.query<{ id: string; kind: string; title: string }>(
    "select id, kind, title from incidents where org_id = $1 and id = $2",
    [orgId, incidentId],
  );
  if (!incident) throw new NotFoundError("Incident");
  const [rule, org] = await Promise.all([
    latestRuleVersion(q, orgId, incidentId),
    q.query<{ settings: { demoData?: boolean } }>("select settings from organisations where id = $1", [orgId]),
  ]);
  const scope = rule?.scope.type === "product" ? rule.scope : null;
  const labels = { merchantRecords: org[0]?.settings?.demoData ? "synthetic" : "merchant" };

  if (!scope) {
    return { incident, labels, refundWindowDays: PAYPAL_REFUND_WINDOW_DAYS, closingSoonDays: CLOSING_SOON_DAYS, scope: null, batches: [], mixedStock: [], records: [], summary: null };
  }

  const skus = scope.skus.map(normSku);
  const affectedCodes = new Set(scope.batchCodes.map(normCode));
  const batchRows = await q.query<{
    id: string; sku: string; batch_code: string; warehouse: string; quantity: number | null;
    received_at: Date | null; first_shipped_at: Date | null; last_shipped_at: Date | null;
  }>(
    `select b.id, v.sku, b.batch_code, b.warehouse, b.quantity, b.received_at, b.first_shipped_at, b.last_shipped_at
       from inventory_batches b
       join product_variants v on v.org_id = b.org_id and v.id = b.variant_id
      where b.org_id = $1 and upper(trim(v.sku)) = any($2::text[])
      order by v.sku, coalesce(b.first_shipped_at, b.received_at), b.batch_code`,
    [orgId, skus],
  );
  const batches: TimelineBatch[] = batchRows.map((b) => ({
    id: b.id, sku: b.sku, batchCode: b.batch_code, warehouse: b.warehouse, quantity: b.quantity,
    receivedAt: iso(b.received_at), firstShippedAt: iso(b.first_shipped_at), lastShippedAt: iso(b.last_shipped_at),
    // With no batch codes in the rules, every unit of these SKUs is in scope.
    affected: affectedCodes.size === 0 || affectedCodes.has(normCode(b.batch_code)),
  }));

  const rows = await q.query<{
    id: string; order_number: string | null; customer_name: string | null; sku: string | null; affected_quantity: number;
    placed_at: Date | null; payment_identity: string; eligibility: string; disposition: Disposition;
    paid_at: Date | null; payment_kind: string | null; shipped_at: Date | null; warehouse: string | null; recorded: string[] | null;
  }>(
    `select c.id, o.order_number, c.customer_name, l.sku, c.affected_quantity, o.placed_at,
            c.payment_identity, c.eligibility, ${DISPOSITION_SQL} as disposition,
            p.occurred_at as paid_at, p.kind as payment_kind,
            f.shipped_at, f.warehouse, f.recorded
       ${MAP_FROM}
       left join lateral (
         select min(fu.shipped_at) as shipped_at, min(fu.warehouse) as warehouse,
                array_remove(array_agg(distinct fl.batch_code), null) as recorded
           from fulfilment_lines fl
           join fulfilments fu on fu.org_id = fl.org_id and fu.id = fl.fulfilment_id
          where fl.org_id = c.org_id and fl.order_line_id = c.order_line_id) f on true
      where c.org_id = $1 and c.incident_id = $2
      order by f.shipped_at nulls last, o.placed_at nulls last, c.id`,
    [orgId, incidentId],
  );

  const records: TimelineRecord[] = rows.map((r) => {
    const paidAt = r.payment_kind === "payment" && r.paid_at ? new Date(r.paid_at) : null;
    return {
      candidateId: r.id,
      orderNumber: r.order_number,
      customerName: r.customer_name,
      sku: r.sku,
      quantity: r.affected_quantity,
      placedAt: iso(r.placed_at),
      shippedAt: iso(r.shipped_at),
      warehouse: r.warehouse,
      recordedBatches: r.recorded ?? [],
      paymentIdentity: r.payment_identity,
      eligibility: r.eligibility,
      disposition: r.disposition,
      dispositionLabel: DISPOSITION_TEXT[r.disposition]?.label ?? r.disposition,
      paidAt: iso(paidAt),
      ...refundDeadline(paidAt, now),
    };
  });

  const count = (state: DeadlineState) => records.filter((r) => r.deadline === state).length;
  const stillOwed = (r: TimelineRecord) => !["paid", "not_affected", "excluded", "declined"].includes(r.disposition);
  return {
    incident,
    labels,
    refundWindowDays: PAYPAL_REFUND_WINDOW_DAYS,
    closingSoonDays: CLOSING_SOON_DAYS,
    scope: { skus: scope.skus, batchCodes: scope.batchCodes, shippedFrom: scope.shippedFrom, shippedTo: scope.shippedTo },
    batches,
    mixedStock: mixedStockWindows(batches),
    records,
    summary: {
      records: records.length,
      shippedInMixedStock: records.filter((r) => r.eligibility === "uncertain").length,
      windowOpen: count("open"),
      closingSoon: count("closing_soon"),
      closed: count("closed"),
      noPaypalPayment: count("no_paypal_payment"),
      /** Records still owed something whose PayPal refund window has closed: these need a payout or another route. */
      owedAfterWindowClosed: records.filter((r) => r.deadline === "closed" && stillOwed(r)).length,
      /** Records still owed something whose window closes within the warning period. */
      owedClosingSoon: records.filter((r) => r.deadline === "closing_soon" && stillOwed(r)).length,
    },
  };
}
