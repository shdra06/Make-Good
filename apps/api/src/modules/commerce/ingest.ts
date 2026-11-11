// Writing orders, stock and fulfilment records from any store into our tables.
//
// Every connector (WooCommerce, Shopify, a custom store, a CSV file) turns its
// own format into `OrderImport` and calls `upsertOrder`. Nothing downstream
// knows which store the data came from.
//
// Amounts arrive as decimal strings, exactly as stores report them, and are
// converted to minor units here. A record that does not add up is kept, and
// the mismatch is reported: hiding bad merchant data would be worse.

import { z } from "zod";
import type { Queryable } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { toMinor } from "../../platform/money.ts";

const decimal = z.string().regex(/^\d+(\.\d+)?$/, "must be a plain decimal such as 12.50");
const isoDate = z.iso.datetime({ offset: true });

export const OrderImport = z.object({
  externalId: z.string().min(1).max(200),
  orderNumber: z.string().min(1).max(200),
  channel: z.enum(["online", "pos", "marketplace", "subscription", "other"]).default("online"),
  placedAt: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/),
  customer: z
    .object({
      email: z.string().max(320).nullable().default(null),
      name: z.string().max(200).nullable().default(null),
      externalId: z.string().max(200).nullable().default(null),
      isGuest: z.boolean().default(false),
    })
    .default({ email: null, name: null, externalId: null, isGuest: false }),
  billingEmail: z.string().max(320).nullable().default(null),
  shippingName: z.string().max(200).nullable().default(null),
  shippingCountry: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  paymentMethod: z.enum(["paypal", "card", "cash", "bank", "other", "unknown"]).default("unknown"),
  /** The payment ID the store recorded. For PayPal this should be the capture or transaction ID. */
  paymentReference: z.string().max(200).nullable().default(null),
  discount: decimal.default("0"),
  shipping: decimal.default("0"),
  tax: decimal.default("0"),
  total: decimal,
  status: z.enum(["pending", "paid", "partially_refunded", "refunded", "cancelled"]).default("paid"),
  lines: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200).optional(),
        sku: z.string().max(200).nullable().default(null),
        title: z.string().min(1).max(500),
        kind: z.enum(["physical", "digital", "subscription", "ticket", "service"]).default("physical"),
        quantity: z.number().int().positive(),
        unitPrice: decimal,
        discount: decimal.default("0"),
        tax: decimal.default("0"),
        parentExternalId: z.string().max(200).optional(),
        serviceStart: isoDate.nullable().default(null),
        serviceEnd: isoDate.nullable().default(null),
      }),
    )
    .min(1)
    .max(500),
  fulfilments: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200).optional(),
        shippedAt: isoDate.nullable().default(null),
        warehouse: z.string().min(1).max(100).default("default"),
        tracking: z.string().max(200).nullable().default(null),
        lines: z
          .array(
            z.object({
              lineExternalId: z.string().min(1).max(200),
              quantity: z.number().int().positive(),
              batchCode: z.string().max(100).nullable().default(null),
              serials: z.array(z.string().max(100)).max(1000).default([]),
            }),
          )
          .min(1),
      }),
    )
    .default([]),
  adjustments: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200).optional(),
        kind: z.enum(["return", "replacement", "store_refund", "cancellation"]),
        lineExternalId: z.string().max(200).optional(),
        quantity: z.number().int().min(0).default(0),
        amount: decimal.default("0"),
        occurredAt: isoDate,
        note: z.string().max(500).optional(),
      }),
    )
    .default([]),
  raw: z.unknown().optional(),
});
export type OrderImport = z.infer<typeof OrderImport>;

export const BatchImport = z.object({
  sku: z.string().min(1).max(200),
  batchCode: z.string().min(1).max(100),
  warehouse: z.string().min(1).max(100).default("default"),
  quantity: z.number().int().min(0).nullable().default(null),
  receivedAt: isoDate.nullable().default(null),
  firstShippedAt: isoDate.nullable().default(null),
  lastShippedAt: isoDate.nullable().default(null),
  note: z.string().max(500).optional(),
});
export type BatchImport = z.infer<typeof BatchImport>;

export const normEmail = (email: string | null | undefined): string | null =>
  email ? email.trim().toLowerCase() : null;

/** Finds or creates the product and variant for a SKU. */
export async function ensureVariant(q: Queryable, orgId: string, sku: string, title: string, connectionId: string | null): Promise<string> {
  const existing = await q.query<{ id: string }>("select id from product_variants where org_id = $1 and sku = $2", [orgId, sku]);
  if (existing[0]) return existing[0].id;
  const [product] = await q.query<{ id: string }>(
    "insert into products (org_id, connection_id, title) values ($1, $2, $3) returning id",
    [orgId, connectionId, title],
  );
  const rows = await q.query<{ id: string }>(
    `insert into product_variants (org_id, product_id, sku, title) values ($1, $2, $3, $4)
     on conflict (org_id, sku) do update set title = coalesce(product_variants.title, excluded.title)
     returning id`,
    [orgId, product!.id, sku, title],
  );
  return rows[0]!.id;
}

export type UpsertResult = { orderId: string; created: boolean; warnings: string[] };

/** Inserts or updates one order with its lines, fulfilments and adjustments. Call inside a transaction. */
export async function upsertOrder(q: Queryable, orgId: string, connectionId: string, input: OrderImport): Promise<UpsertResult> {
  const cur = input.currency;
  const warnings: string[] = [];
  const lines = input.lines.map((l, i) => ({
    ...l,
    externalId: l.externalId ?? `line-${i + 1}`,
    unitMinor: toMinor(l.unitPrice, cur),
    discountMinor: toMinor(l.discount, cur),
    taxMinor: toMinor(l.tax, cur),
  }));
  const subtotal = lines.reduce((a, l) => a + l.unitMinor * l.quantity, 0);
  const lineDiscounts = lines.reduce((a, l) => a + l.discountMinor, 0);
  const discount = Math.max(toMinor(input.discount, cur), lineDiscounts);
  const shipping = toMinor(input.shipping, cur);
  const lineTax = lines.reduce((a, l) => a + l.taxMinor, 0);
  const tax = Math.max(toMinor(input.tax, cur), lineTax);
  const total = toMinor(input.total, cur);
  const expected = subtotal - discount + shipping + tax;
  if (expected !== total) {
    warnings.push(
      `Order ${input.orderNumber}: the lines, discount, shipping and tax add up to ${expected} minor units, but the order total is ${total}.`,
    );
  }
  for (const l of lines) {
    if (l.discountMinor > l.unitMinor * l.quantity) {
      warnings.push(`Order ${input.orderNumber}: line ${l.externalId} has a discount larger than its price. The discount was capped.`);
      l.discountMinor = l.unitMinor * l.quantity;
    }
  }

  const rows = await q.query<{ id: string; created: boolean }>(
    `insert into orders
       (org_id, connection_id, external_id, order_number, channel, placed_at, currency, customer_email,
        customer_email_normalized, customer_name, customer_external_id, is_guest, billing_email, shipping_name,
        shipping_country, payment_method, payment_reference, subtotal_minor, discount_minor, shipping_minor,
        tax_minor, total_minor, status, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)
     on conflict (org_id, connection_id, external_id) do update set
       order_number = excluded.order_number, channel = excluded.channel, placed_at = excluded.placed_at,
       currency = excluded.currency, customer_email = excluded.customer_email,
       customer_email_normalized = excluded.customer_email_normalized, customer_name = excluded.customer_name,
       customer_external_id = excluded.customer_external_id, is_guest = excluded.is_guest,
       billing_email = excluded.billing_email, shipping_name = excluded.shipping_name,
       shipping_country = excluded.shipping_country, payment_method = excluded.payment_method,
       payment_reference = excluded.payment_reference, subtotal_minor = excluded.subtotal_minor,
       discount_minor = excluded.discount_minor, shipping_minor = excluded.shipping_minor,
       tax_minor = excluded.tax_minor, total_minor = excluded.total_minor, status = excluded.status,
       raw = excluded.raw, updated_at = now()
     returning id, (xmax = 0) as created`,
    [
      orgId, connectionId, input.externalId, input.orderNumber, input.channel, input.placedAt, cur,
      input.customer.email, normEmail(input.customer.email), input.customer.name, input.customer.externalId,
      input.customer.isGuest, input.billingEmail, input.shippingName, input.shippingCountry, input.paymentMethod,
      input.paymentReference, subtotal, discount, shipping, tax, total, input.status,
      json({ source: input.raw ?? null, warnings }),
    ],
  );
  const orderId = rows[0]!.id;

  // Lines: upsert by the store's line ID so that existing candidates keep pointing at the same row.
  const lineIds = new Map<string, string>();
  for (const [i, l] of lines.entries()) {
    const variantId = l.sku ? await ensureVariant(q, orgId, l.sku, l.title, connectionId) : null;
    const [row] = await q.query<{ id: string }>(
      `insert into order_lines
         (org_id, order_id, external_id, variant_id, sku, title, kind, quantity, unit_price_minor, discount_minor,
          tax_minor, service_start, service_end, position)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (org_id, order_id, external_id) where external_id is not null do update set
         variant_id = excluded.variant_id, sku = excluded.sku, title = excluded.title, kind = excluded.kind,
         quantity = excluded.quantity, unit_price_minor = excluded.unit_price_minor,
         discount_minor = excluded.discount_minor, tax_minor = excluded.tax_minor,
         service_start = excluded.service_start, service_end = excluded.service_end, position = excluded.position
       returning id`,
      [orgId, orderId, l.externalId, variantId, l.sku, l.title, l.kind, l.quantity, l.unitMinor, l.discountMinor,
       l.taxMinor, l.serviceStart, l.serviceEnd, i],
    );
    lineIds.set(l.externalId, row!.id);
  }
  for (const l of lines) {
    if (!l.parentExternalId) continue;
    const parent = lineIds.get(l.parentExternalId);
    if (parent) await q.query("update order_lines set parent_line_id = $1 where id = $2 and org_id = $3", [parent, lineIds.get(l.externalId), orgId]);
    else warnings.push(`Order ${input.orderNumber}: line ${l.externalId} names a parent line that is not in the order.`);
  }

  for (const [i, f] of input.fulfilments.entries()) {
    const externalId = f.externalId ?? `fulfilment-${i + 1}`;
    const [row] = await q.query<{ id: string }>(
      `insert into fulfilments (org_id, order_id, external_id, shipped_at, warehouse, tracking)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (org_id, order_id, external_id) where external_id is not null do update set
         shipped_at = excluded.shipped_at, warehouse = excluded.warehouse, tracking = excluded.tracking
       returning id`,
      [orgId, orderId, externalId, f.shippedAt, f.warehouse, f.tracking],
    );
    await q.query("delete from fulfilment_lines where org_id = $1 and fulfilment_id = $2", [orgId, row!.id]);
    for (const fl of f.lines) {
      const lineId = lineIds.get(fl.lineExternalId);
      if (!lineId) {
        warnings.push(`Order ${input.orderNumber}: a fulfilment names line ${fl.lineExternalId}, which is not in the order.`);
        continue;
      }
      await q.query(
        `insert into fulfilment_lines (org_id, fulfilment_id, order_line_id, quantity, batch_code, serials)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [orgId, row!.id, lineId, fl.quantity, fl.batchCode, json(fl.serials)],
      );
    }
  }

  for (const [i, a] of input.adjustments.entries()) {
    const lineId = a.lineExternalId ? lineIds.get(a.lineExternalId) ?? null : null;
    if (a.lineExternalId && !lineId) {
      warnings.push(`Order ${input.orderNumber}: an adjustment names line ${a.lineExternalId}, which is not in the order.`);
    }
    await q.query(
      `insert into order_adjustments (org_id, order_id, order_line_id, kind, quantity, amount_minor, occurred_at, note, external_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (org_id, order_id, external_id) where external_id is not null do update set
         order_line_id = excluded.order_line_id, kind = excluded.kind, quantity = excluded.quantity,
         amount_minor = excluded.amount_minor, occurred_at = excluded.occurred_at, note = excluded.note`,
      [orgId, orderId, lineId, a.kind, a.quantity, toMinor(a.amount, cur), a.occurredAt, a.note ?? null, a.externalId ?? `adjustment-${i + 1}`],
    );
  }
  return { orderId, created: rows[0]!.created, warnings };
}

export async function upsertBatch(q: Queryable, orgId: string, input: BatchImport): Promise<string> {
  const variantId = await ensureVariant(q, orgId, input.sku, input.sku, null);
  const rows = await q.query<{ id: string }>(
    `insert into inventory_batches (org_id, variant_id, batch_code, warehouse, quantity, received_at, first_shipped_at, last_shipped_at, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (org_id, variant_id, batch_code, warehouse) do update set
       quantity = excluded.quantity, received_at = excluded.received_at,
       first_shipped_at = excluded.first_shipped_at, last_shipped_at = excluded.last_shipped_at, note = excluded.note
     returning id`,
    [orgId, variantId, input.batchCode, input.warehouse, input.quantity, input.receivedAt, input.firstShippedAt, input.lastShippedAt, input.note ?? null],
  );
  return rows[0]!.id;
}
