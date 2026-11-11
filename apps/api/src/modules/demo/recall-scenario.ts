// The flagship test case: a supplier recalls one production batch of a hand
// mixer, and the merchant's records are as untidy as real ones.
//
// EVERYTHING the merchant "knows" here is invented: the supplier notice, the
// orders, the stock records. It is stored with the label "synthetic". The
// payments are real only in the sense that they exist at whichever PayPal the
// caller connects: the built-in simulator, or PayPal's sandbox.
//
// Because we invent each record, we also know the right answer for it. Those
// answers are written to `evaluation_labels`, where the matching engine never
// looks. Accuracy is then measured against them, not asserted.
//
// The untidiness is deliberate. Each case below exists to catch one specific
// way of paying the wrong person, the wrong amount, or nobody.

import { createHash } from "node:crypto";
import type { Clock } from "../../platform/clock.ts";
import { DAY, MINUTE } from "../../platform/clock.ts";
import type { Db } from "../../platform/db/db.ts";
import { fromMinor } from "../../platform/money.ts";
import { audit } from "../../platform/audit.ts";
import { BatchImport, ensureVariant, OrderImport, upsertBatch, upsertOrder } from "../commerce/ingest.ts";
import type { PayPalProvider } from "../paypal/provider.ts";
import { linkOrdersToPayments } from "../transactions/sync.ts";

export const RECALL_DATASET = "hm300-recall-v1";
export const RECALL_STORE_NAME = "Kitchen store (synthetic records)";
export const AFFECTED_BATCH = "B-2217";

export type PayRequest = {
  key: string;
  amountMinor: number;
  currency: "USD";
  invoiceId: string | null;
  payer: { email: string; name: string };
  /** When the payment should be dated. The simulator honours it; the sandbox cannot, and says when it really was. */
  at: Date;
  item: { sku: string; title: string; quantity: number; unitMinor: number };
};
export type Paid = { captureId: string; createdAt: Date };

export type ScenarioIo = {
  mode: "simulator" | "sandbox";
  now: Date;
  /** Put before every order number, so two runs on one PayPal account never share an invoice number. */
  prefix: string;
  /** Takes a test payment. Only test data loaders do this; the product itself never takes payments. */
  pay(request: PayRequest): Promise<Paid>;
  /** Used for refunds the store made before the incident, outside Make Good. */
  provider: PayPalProvider;
  /** Simulator only: PayPal's sandbox cannot open a dispute on request. */
  openDispute?(captureId: string): void;
  onProgress?(message: string): void;
};

export type Label = {
  lineExternalId: string;
  caseTag: string;
  note: string;
  /** Units of the recalled batch the customer still holds. This is the right answer for eligibility. */
  affectedUnits: number;
  /** What a correct refund through PayPal would be, in minor units. */
  owedMinor: number;
  /** The PayPal payment that really paid for the order. */
  trueCaptureId: string | null;
};

export type ScenarioData = {
  dataset: string;
  mode: "simulator" | "sandbox";
  notice: { title: string; body: string };
  catalogue: Array<{ sku: string; title: string }>;
  batches: BatchImport[];
  orders: Array<{ order: OrderImport; labels: Label[] }>;
  /** Every test payment created, so a caller without Transaction Search can fetch each one by ID. */
  captureIds: string[];
  /** Cases left out in this mode, and why. */
  skipped: Array<{ caseTag: string; why: string }>;
};

const HM300 = { sku: "HM-300", title: "Hand mixer HM-300", unitMinor: 5900 };
const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The supplier's notice. Written the way such notices are: the facts are there, spread across sentences, with distractors. */
export function recallNotice(now: Date): { title: string; body: string } {
  const ago = (days: number) => longDate(new Date(now.getTime() - days * DAY));
  return {
    title: "Safety recall notice KA-RN-2026-031 (Kestrel Appliances)",
    body: [
      "SAFETY RECALL NOTICE  Ref. KA-RN-2026-031",
      "From: Kestrel Appliances Ltd, Quality Assurance",
      "To: all retail partners",
      `Date: ${ago(9)}`,
      "",
      "Product: HM-300 hand mixer (catalogue code HM-300). The EU-plug version, sold as HM-300-EU, is the same unit and is included in this recall.",
      "",
      `Affected production batch: ${AFFECTED_BATCH} only. The batch code is printed on the rating label under the motor housing and on the carton flap.`,
      "",
      "Not affected: batches B-2209 and B-2224 of the same model, and the HM-3000 stand mixer, which uses a different motor.",
      "",
      "Fault: the speed controller can overheat after about ten minutes of continuous use.",
      "",
      `Batch ${AFFECTED_BATCH} left our warehouse for retail partners between ${ago(52)} and ${ago(44)}.`,
      "",
      `Action for retailers: stop sale of batch ${AFFECTED_BATCH}, contact buyers, and offer a full refund of the purchase price. Units need not be returned.`,
      "",
      "Questions: recalls@kestrel-appliances.example",
    ].join("\n"),
  };
}

/**
 * Builds the scenario: takes the test payments, makes the refunds that are
 * part of the back story, and returns the merchant's records with the right
 * answer for each. Nothing is written to our database here.
 */
export async function buildRecallScenario(io: ScenarioIo): Promise<ScenarioData> {
  const { now, mode } = io;
  const say = io.onProgress ?? (() => undefined);
  const daysAgo = (d: number, minute = 0) => new Date(now.getTime() - d * DAY + minute * MINUTE);
  const orders: ScenarioData["orders"] = [];
  const captureIds: string[] = [];
  const skipped: ScenarioData["skipped"] = [];
  let n = 5000;

  type LineSpec = {
    sku: string | null; title: string; quantity?: number; unitMinor?: number;
    /** One entry per shipment of this line. Omit for "nothing recorded". */
    shipped?: Array<{ daysAgo: number; quantity?: number; batchCode?: string | null }>;
  };
  type Sale = {
    tag: string; note: string;
    customer?: { email: string; name: string };
    placedDaysAgo: number;
    lines: LineSpec[];
    discountMinor?: number; shippingMinor?: number;
    /** How the store and PayPal are tied together for this order. */
    payment: "reference" | "invoice_only" | "none_recorded" | "card" | "wrong_reference";
    orderNumber?: string;
    /** Right answers, one per line that is the recalled product (by any spelling). */
    truth: Array<{ line: number; affectedUnits: number; owedMinor: number }>;
    adjustments?: Array<{ kind: "return" | "store_refund"; line: number; quantity?: number; amountMinor?: number; daysAgo: number; note: string }>;
    after?(captureId: string): Promise<void> | void;
    /** Share the payment of an earlier sale instead of taking a new one (never used for the same order twice). */
    payerOverride?: { email: string; name: string };
  };

  async function sell(sale: Sale): Promise<{ captureId: string | null; orderNumber: string }> {
    n += 1;
    const orderNumber = sale.orderNumber ?? `${io.prefix}${n}`;
    const customer = sale.customer ?? { email: `buyer.${n}@example.com`, name: `Buyer ${n}` };
    const placedAt = daysAgo(sale.placedDaysAgo, n % 400);
    const lines = sale.lines.map((l, i) => ({ ...l, externalId: `l${i + 1}`, quantity: l.quantity ?? 1, unitMinor: l.unitMinor ?? HM300.unitMinor }));
    const subtotal = lines.reduce((a, l) => a + l.unitMinor * l.quantity, 0);
    const total = subtotal - (sale.discountMinor ?? 0) + (sale.shippingMinor ?? 0);

    let paid: Paid | null = null;
    if (sale.payment !== "card" && sale.payment !== "wrong_reference") {
      const first = lines[0]!;
      paid = await io.pay({
        key: `${sale.tag}-${n}`, amountMinor: total, currency: "USD",
        invoiceId: sale.payment === "none_recorded" ? null : orderNumber,
        payer: sale.payerOverride ?? customer,
        at: new Date(placedAt.getTime() + MINUTE),
        item: { sku: first.sku ?? "ITEM", title: first.title, quantity: first.quantity, unitMinor: first.unitMinor },
      });
      captureIds.push(paid.captureId);
      say(`payment for ${sale.tag} ${orderNumber}: ${paid.captureId}`);
      if (sale.after) await sale.after(paid.captureId);
    }
    // Where nothing but email, amount and time can tie the order to its payment, the order must sit next to the payment in time.
    const placed = sale.payment === "none_recorded" && paid ? new Date(paid.createdAt.getTime() - MINUTE) : placedAt;

    const fulfilments = new Map<number, Array<{ lineExternalId: string; quantity: number; batchCode: string | null }>>();
    for (const l of lines) {
      for (const s of l.shipped ?? []) {
        const list = fulfilments.get(s.daysAgo) ?? [];
        list.push({ lineExternalId: l.externalId, quantity: s.quantity ?? l.quantity, batchCode: s.batchCode ?? null });
        fulfilments.set(s.daysAgo, list);
      }
    }
    const order = OrderImport.parse({
      externalId: `${RECALL_DATASET}-${n}`,
      orderNumber,
      placedAt: placed.toISOString(),
      currency: "USD",
      customer: { email: customer.email, name: customer.name },
      paymentMethod: sale.payment === "card" ? "card" : "paypal",
      paymentReference:
        sale.payment === "reference" ? paid!.captureId
        : sale.payment === "wrong_reference" ? (mode === "simulator" ? `SIMCAPNOTFOUND${n}` : `0ZZ${n}0000ZZ00000Z`)
        : null,
      discount: fromMinor(sale.discountMinor ?? 0, "USD"),
      shipping: fromMinor(sale.shippingMinor ?? 0, "USD"),
      total: fromMinor(total, "USD"),
      lines: lines.map((l) => ({ externalId: l.externalId, sku: l.sku, title: l.title, quantity: l.quantity, unitPrice: fromMinor(l.unitMinor, "USD") })),
      fulfilments: [...fulfilments.entries()].map(([days, fl], i) => ({
        externalId: `f${i + 1}`, shippedAt: daysAgo(days).toISOString(), warehouse: "default", lines: fl,
      })),
      adjustments: (sale.adjustments ?? []).map((a, i) => ({
        externalId: `a${i + 1}`, kind: a.kind, lineExternalId: `l${a.line + 1}`, quantity: a.quantity ?? 0,
        amount: fromMinor(a.amountMinor ?? 0, "USD"), occurredAt: daysAgo(a.daysAgo).toISOString(), note: a.note,
      })),
      raw: { synthetic: true, dataset: RECALL_DATASET, caseTag: sale.tag },
    });
    orders.push({
      order,
      labels: sale.truth.map((t) => ({
        lineExternalId: `l${t.line + 1}`, caseTag: sale.tag, note: sale.note, affectedUnits: t.affectedUnits, owedMinor: t.owedMinor,
        trueCaptureId: paid?.captureId ?? null,
      })),
    });
    return { captureId: paid?.captureId ?? null, orderNumber };
  }

  const packed = (days: number, batchCode: string | null = AFFECTED_BATCH, quantity?: number) => [{ daysAgo: days, batchCode, quantity }];
  const hm = (extra: Partial<LineSpec> = {}): LineSpec => ({ sku: HM300.sku, title: HM300.title, ...extra });
  const one = (affectedUnits: number, owedMinor: number) => [{ line: 0, affectedUnits, owedMinor }];

  // ---- A. Purchases the records settle completely ----
  await sell({ tag: "clean", note: "Batch recorded at packing; PayPal's payment ID recorded on the order.", placedDaysAgo: 38, lines: [hm({ shipped: packed(37) })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "clean", note: "As above.", placedDaysAgo: 36, lines: [hm({ shipped: packed(35) })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "two_units", note: "Two units, both from the recalled batch.", placedDaysAgo: 35, lines: [hm({ quantity: 2, shipped: packed(34) })], payment: "reference", truth: one(2, 11800) });
  await sell({ tag: "batch_code_written_differently", note: "The packer wrote 'b 2217'. Same batch.", placedDaysAgo: 33, lines: [hm({ shipped: packed(32, "b 2217") })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "product_code_case_and_spaces", note: "Product code typed in lower case with a space, title in capitals.", placedDaysAgo: 32, lines: [hm({ sku: " hm-300", title: "HAND MIXER HM-300 WHT", shipped: packed(31) })], payment: "reference", truth: one(1, 5900) });
  await sell({
    tag: "multi_item_order", note: "Mixer and kettle in one order, with a 10% order discount and shipping. Only the mixer's share is owed: 59.00 less 5.90 of the discount.",
    placedDaysAgo: 31, lines: [hm({ shipped: packed(30) }), { sku: "KT-120", title: "Kettle KT-120", unitMinor: 3900, shipped: [{ daysAgo: 30 }] }],
    discountMinor: 980, shippingMinor: 600, payment: "reference", truth: one(1, 5310),
  });
  await sell({ tag: "eu_plug_variant", note: "The EU-plug version. The supplier's notice says it is included.", placedDaysAgo: 30, lines: [{ sku: "HM-300-EU", title: "Hand mixer HM-300 (EU plug)", shipped: packed(29) }], payment: "reference", truth: one(1, 5900) });
  await sell({
    tag: "partly_refunded_before", note: "The store already gave 20.00 back for a late delivery. Only 39.00 is left to refund.",
    placedDaysAgo: 29, lines: [hm({ shipped: packed(28) })], payment: "reference", truth: one(1, 3900),
    adjustments: [{ kind: "store_refund", line: 0, amountMinor: 2000, daysAgo: 20, note: "goodwill for late delivery" }],
    after: async (captureId) => {
      await io.provider.refundCapture(captureId, { requestId: `mg-seed-goodwill-${captureId}`, amount: { currency_code: "USD", value: "20.00" }, noteToPayer: "Goodwill refund for late delivery." });
    },
  });
  await sell({
    tag: "units_from_two_batches", note: "Two units in one line: one from the recalled batch, one from the next batch. One unit is owed.",
    placedDaysAgo: 26, lines: [hm({ quantity: 2, shipped: [{ daysAgo: 25, quantity: 1, batchCode: AFFECTED_BATCH }, { daysAgo: 25, quantity: 1, batchCode: "B-2224" }] })],
    payment: "reference", truth: one(1, 5900),
  });
  const repeat = { email: "sam.rivera@example.com", name: "Sam Rivera" };
  await sell({ tag: "repeat_customer", note: "Sam Rivera's first purchase: recalled batch.", customer: repeat, placedDaysAgo: 34, lines: [hm({ shipped: packed(33) })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "repeat_customer", note: "Sam Rivera's second purchase, three weeks later: a later batch. Not affected, and must not be paid because the first one was.", customer: repeat, placedDaysAgo: 12, lines: [hm({ shipped: packed(11, "B-2224") })], payment: "reference", truth: one(0, 0) });

  // ---- B. Same product, other batches: must be left out ----
  await sell({ tag: "other_batch", note: "Earlier batch B-2209, recorded at packing.", placedDaysAgo: 55, lines: [hm({ shipped: packed(54, "B-2209") })], payment: "reference", truth: one(0, 0) });
  await sell({ tag: "other_batch", note: "Later batch B-2224, recorded at packing.", placedDaysAgo: 10, lines: [hm({ shipped: packed(9, "B-2224") })], payment: "reference", truth: one(0, 0) });
  await sell({
    tag: "similar_product_code", note: "A different product (stand mixer HM-3000) whose carton happens to carry the same batch number. Not part of the recall.",
    placedDaysAgo: 30, lines: [{ sku: "HM-3000", title: "Stand mixer HM-3000", unitMinor: 24900, shipped: packed(29) }], payment: "reference", truth: one(0, 0),
  });

  // ---- C. Product written in a way the catalogue does not know ----
  await sell({ tag: "product_code_without_hyphen", note: "Entered by phone sales as 'HM300'. It is the recalled mixer, from the recalled batch.", placedDaysAgo: 28, lines: [{ sku: "HM300", title: "Hand Mixer 300W", shipped: packed(27) }], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "no_product_code", note: "A marketplace order with no product code at all, only a title. Recalled mixer, recalled batch.", placedDaysAgo: 27, lines: [{ sku: null, title: "Kestrel hand mixer HM-300 white", shipped: packed(26) }], payment: "reference", truth: one(1, 5900) });

  // ---- D. No batch recorded at packing ----
  await sell({ tag: "no_batch_single_stock", note: "No batch written down. Shipped while only the recalled batch was going out. In truth: affected.", placedDaysAgo: 34, lines: [hm({ shipped: packed(33, null) })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "no_batch_single_stock", note: "As above. In truth: affected.", placedDaysAgo: 32, lines: [hm({ shipped: packed(31, null) })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "no_batch_mixed_stock", note: "No batch written down. Shipped while two batches were going out together. In truth: affected.", placedDaysAgo: 26, lines: [hm({ shipped: packed(25, null) })], payment: "reference", truth: one(1, 5900) });
  await sell({ tag: "no_batch_mixed_stock", note: "Same week, same gap in the records. In truth: NOT affected. Paying this customer on the ship date alone would be wrong.", placedDaysAgo: 25, lines: [hm({ shipped: packed(24, null) })], payment: "reference", truth: one(0, 0) });
  await sell({ tag: "no_shipping_record", note: "No shipping record at all. In truth: not affected.", placedDaysAgo: 23, lines: [hm()], payment: "reference", truth: one(0, 0) });

  // ---- E. Payment not settled ----
  // A number from the old order series, so it cannot collide with the numbers this loader hands out.
  const shared = `${io.prefix}4871`;
  await sell({ tag: "duplicate_invoice_number", note: "Two different orders were given the same order number after a system migration, and both PayPal payments carry it. Affected, but which payment is whose is not in the records.", orderNumber: shared, placedDaysAgo: 31, lines: [hm({ shipped: packed(30) })], payment: "invoice_only", truth: one(1, 5900) });
  await sell({ tag: "duplicate_invoice_number", note: "The other order with that number.", orderNumber: shared, placedDaysAgo: 31, lines: [hm({ shipped: packed(30) })], payment: "invoice_only", truth: one(1, 5900) });
  if (mode === "simulator") {
    await sell({ tag: "no_shared_identifier", note: "The store recorded no payment ID and the payment carries no order number. Only email, amount and time agree.", placedDaysAgo: 30, lines: [hm({ shipped: packed(29) })], payment: "none_recorded", truth: one(1, 5900) });
  } else {
    skipped.push({ caseTag: "no_shared_identifier", why: "Needs the payer's email on the PayPal payment, which only Transaction Search returns. This PayPal app does not have that permission." });
  }
  await sell({ tag: "payment_id_not_found", note: "The store recorded a PayPal payment ID that PayPal does not know (a typing error). Affected, but there is no payment to refund yet.", placedDaysAgo: 29, lines: [hm({ shipped: packed(28) })], payment: "wrong_reference", truth: one(1, 0) });

  // ---- F. Affected, but must not be refunded through PayPal now ----
  await sell({
    tag: "returned", note: "Recalled batch, but the customer already sent it back and was refunded by the store.", placedDaysAgo: 37, lines: [hm({ shipped: packed(36) })],
    payment: "reference", truth: one(0, 0), adjustments: [{ kind: "return", line: 0, quantity: 1, daysAgo: 20, note: "customer return" }],
    after: async (captureId) => {
      await io.provider.refundCapture(captureId, { requestId: `mg-seed-return-${captureId}`, noteToPayer: "Refund for your return." });
    },
  });
  await sell({ tag: "paid_by_card", note: "Recalled batch, paid by card at the counter. Owed, but not through PayPal.", placedDaysAgo: 36, lines: [hm({ shipped: packed(35) })], payment: "card", truth: one(1, 0) });
  await sell({
    tag: "already_refunded_in_full", note: "Recalled batch. Customer service refunded the whole payment last week, with no return recorded.", placedDaysAgo: 35, lines: [hm({ shipped: packed(34) })],
    payment: "reference", truth: one(1, 0),
    after: async (captureId) => {
      await io.provider.refundCapture(captureId, { requestId: `mg-seed-full-${captureId}`, noteToPayer: "Refund from customer service." });
    },
  });
  if (io.openDispute) {
    const open = io.openDispute;
    await sell({ tag: "dispute_open", note: "Recalled batch, and the buyer has opened a PayPal dispute. Refunding outside the dispute could pay twice.", placedDaysAgo: 33, lines: [hm({ shipped: packed(32) })], payment: "reference", truth: one(1, 0), after: (captureId) => open(captureId) });
  } else {
    skipped.push({ caseTag: "dispute_open", why: "PayPal's sandbox cannot open a dispute on request." });
  }

  // ---- G. The rest of the shop: other electronics, not part of the incident ----
  await sell({ tag: "other_product", note: "", placedDaysAgo: 28, lines: [{ sku: "KT-120", title: "Kettle KT-120", unitMinor: 3900, shipped: [{ daysAgo: 27 }] }], payment: "reference", truth: [] });
  if (mode === "simulator") {
    await sell({ tag: "other_product", note: "", placedDaysAgo: 21, lines: [{ sku: "BL-80", title: "Blender BL-80", unitMinor: 8900, shipped: [{ daysAgo: 20 }] }], payment: "reference", truth: [] });
    await sell({ tag: "other_product", note: "", placedDaysAgo: 15, lines: [{ sku: "HM-3000", title: "Stand mixer HM-3000", unitMinor: 24900, shipped: [{ daysAgo: 14, batchCode: "S-0412" }] }], payment: "reference", truth: [] });
    // A PayPal payment for the mixer with no order in the store's export.
    const stray = await io.pay({
      key: "orphan", amountMinor: 5900, currency: "USD", invoiceId: null, payer: { email: "walk.in@example.com", name: "Walk-in Buyer" },
      at: daysAgo(30, 15), item: { sku: HM300.sku, title: HM300.title, quantity: 1, unitMinor: 5900 },
    });
    captureIds.push(stray.captureId);
  } else {
    skipped.push({ caseTag: "payment_with_no_order", why: "Without Transaction Search, a payment that no order names never reaches Make Good." });
  }

  const window = (first: number, last: number) => ({ firstShippedAt: daysAgo(first).toISOString(), lastShippedAt: daysAgo(last).toISOString() });
  const batches = [
    { batchCode: "B-2209", ...window(60, 41) },
    { batchCode: AFFECTED_BATCH, ...window(40, 22) },
    { batchCode: "B-2224", ...window(27, 2) },
  ].map((b) => BatchImport.parse({ sku: HM300.sku, warehouse: "default", note: "synthetic", ...b }));

  return {
    dataset: RECALL_DATASET,
    mode,
    notice: recallNotice(now),
    catalogue: [
      { sku: "HM-300", title: "Hand mixer HM-300" },
      { sku: "HM-300-EU", title: "Hand mixer HM-300 (EU plug)" },
      { sku: "HM-3000", title: "Stand mixer HM-3000" },
      { sku: "KT-120", title: "Kettle KT-120" },
      { sku: "BL-80", title: "Blender BL-80" },
    ],
    batches,
    orders,
    captureIds,
    skipped,
  };
}

/**
 * Writes a built scenario into an organisation: catalogue, stock records,
 * orders, the right answers, and an incident holding the supplier's notice.
 * No rules are saved: reading the notice and confirming what it says is the
 * first step a person takes.
 */
export async function loadRecallScenario(
  deps: { db: Db; clock: Clock },
  input: { orgId: string; userId: string; data: ScenarioData },
): Promise<{ storeId: string; incidentId: string; documentId: string; orders: number; labels: number; warnings: string[] }> {
  const { db, clock } = deps;
  const { data } = input;
  const now = clock.now();
  return db.tx(async (tx) => {
    const [store] = await tx.query<{ id: string }>(
      `insert into commerce_connections (org_id, kind, name, status) values ($1, 'custom', $2, 'connected')
       on conflict (org_id, name) do update set status = 'connected' returning id`,
      [input.orgId, RECALL_STORE_NAME],
    );
    for (const item of data.catalogue) await ensureVariant(tx, input.orgId, item.sku, item.title, store!.id);
    for (const b of data.batches) await upsertBatch(tx, input.orgId, b);

    const warnings: string[] = [];
    let labels = 0;
    for (const { order, labels: truth } of data.orders) {
      const result = await upsertOrder(tx, input.orgId, store!.id, order);
      warnings.push(...result.warnings);
      for (const label of truth) {
        const [line] = await tx.query<{ id: string }>(
          "select id from order_lines where org_id = $1 and order_id = $2 and external_id = $3",
          [input.orgId, result.orderId, label.lineExternalId],
        );
        await tx.query(
          `insert into evaluation_labels (org_id, dataset, order_id, order_line_id, case_tag, note, affected_units, owed_minor, currency, true_capture_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'USD', $9)
           on conflict (org_id, dataset, order_line_id) do update set
             case_tag = excluded.case_tag, note = excluded.note, affected_units = excluded.affected_units,
             owed_minor = excluded.owed_minor, true_capture_id = excluded.true_capture_id`,
          [input.orgId, data.dataset, result.orderId, line!.id, label.caseTag, label.note, label.affectedUnits, label.owedMinor, label.trueCaptureId],
        );
        labels++;
      }
    }
    await linkOrdersToPayments(tx, input.orgId);

    const [incident] = await tx.query<{ id: string }>(
      `insert into incidents (org_id, kind, title, description, created_by, created_at, updated_at)
       values ($1, 'recall', $2, $3, $4, $5, $5) returning id`,
      [
        input.orgId, "HM-300 hand mixer: supplier recall of one production batch",
        "The supplier has recalled one production batch of the HM-300 hand mixer because the speed controller can overheat. The notice is attached. We do not yet know which of our customers received that batch.",
        input.userId, now.toISOString(),
      ],
    );
    const [document] = await tx.query<{ id: string }>(
      `insert into incident_documents (org_id, incident_id, kind, title, body, sha256, data_label, created_by, created_at)
       values ($1, $2, 'supplier_notice', $3, $4, $5, 'synthetic', $6, $7) returning id`,
      [input.orgId, incident!.id, data.notice.title, data.notice.body, createHash("sha256").update(data.notice.body).digest("hex"), input.userId, now.toISOString()],
    );
    await tx.query(`update organisations set settings = settings || '{"demoData": true}'::jsonb where id = $1`, [input.orgId]);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "demo.recall_scenario_loaded", entityType: "incident",
      entityId: incident!.id, data: { dataset: data.dataset, mode: data.mode, orders: data.orders.length, labels, skipped: data.skipped }, at: now,
    });
    return { storeId: store!.id, incidentId: incident!.id, documentId: document!.id, orders: data.orders.length, labels, warnings };
  });
}
