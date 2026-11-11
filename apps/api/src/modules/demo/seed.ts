// Sample data for trying Make Good without a real store or PayPal keys.
//
// It only works on a simulator connection, it names its store "Demo store
// (sample data)", and it sets a flag on the organisation that every screen
// shows. Nothing created here can be mistaken for a real PayPal payment:
// every payment ID starts with "SIM".
//
// The data is built to exercise the hard cases: orders with and without a
// batch code, mixed stock, returns, a customer who paid by card, payments in
// other currencies, an order too old to refund, and a double charge.

import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import { DAY, MINUTE } from "../../platform/clock.ts";
import type { Db } from "../../platform/db/db.ts";
import { ConflictError } from "../../platform/errors.ts";
import { fromMinor } from "../../platform/money.ts";
import { OrderImport, upsertBatch, upsertOrder } from "../commerce/ingest.ts";
import type { PayPalConnections } from "../paypal/connections.ts";
import { syncTransactions } from "../transactions/sync.ts";
import { buildRecallScenario, loadRecallScenario, RECALL_STORE_NAME } from "./recall-scenario.ts";

export const DEMO_STORE_NAME = "Demo store (sample data)";

type Product = { sku: string; title: string; priceMinor: number };
const PRODUCTS: Product[] = [
  { sku: "HM-300", title: "Hand mixer HM-300", priceMinor: 5900 },
  { sku: "HM-500", title: "Stand mixer HM-500", priceMinor: 24900 },
  { sku: "KT-120", title: "Kettle KT-120", priceMinor: 3900 },
  { sku: "PLAN-PRO", title: "Recipe club, monthly", priceMinor: 1200 },
];

const NAMES = ["Asha Rao", "Ben Ortiz", "Chen Wei", "Dana Novak", "Emre Kaya", "Fatima Zahra", "Giorgos Pappas", "Hana Sato", "Ivan Petrov", "Julia Costa", "Kofi Mensah", "Lena Fischer"];

export async function seedDemoData(
  deps: { db: Db; clock: Clock; connections: PayPalConnections },
  input: { orgId: string; userId: string },
): Promise<{ orders: number; payments: number; batches: number }> {
  const { db, clock, connections } = deps;
  const active = await connections.active(input.orgId);
  if (!active || active.environment !== "simulator") {
    throw new ConflictError("NOT_SIMULATOR", "Sample data can only be loaded on a simulator connection, so it is never mixed with real PayPal payments.");
  }
  const existing = await db.query("select 1 from commerce_connections where org_id = $1 and name = $2", [input.orgId, DEMO_STORE_NAME]);
  if (existing.length > 0) throw new ConflictError("ALREADY_SEEDED", "Sample data is already loaded for this organisation.");

  const sim = await connections.simulatorFor(input.orgId);
  const now = clock.now();
  const [store] = await db.query<{ id: string }>(
    "insert into commerce_connections (org_id, kind, name, status) values ($1, 'custom', $2, 'connected') returning id",
    [input.orgId, DEMO_STORE_NAME],
  );
  const daysAgo = (d: number, minute = 0) => new Date(now.getTime() - d * DAY + minute * MINUTE);

  // Stock: the affected batch shipped alone for a week, then overlapped with the next one.
  const batches = [
    { sku: "HM-300", batchCode: "LOT-23A", firstShippedAt: daysAgo(70), lastShippedAt: daysAgo(41) },
    { sku: "HM-300", batchCode: "LOT-24B", firstShippedAt: daysAgo(40), lastShippedAt: daysAgo(22) },
    { sku: "HM-300", batchCode: "LOT-25C", firstShippedAt: daysAgo(27), lastShippedAt: daysAgo(2) },
  ];
  await db.tx(async (tx) => {
    for (const b of batches) {
      await upsertBatch(tx, input.orgId, {
        sku: b.sku, batchCode: b.batchCode, warehouse: "default", quantity: null, receivedAt: null,
        firstShippedAt: b.firstShippedAt.toISOString(), lastShippedAt: b.lastShippedAt.toISOString(), note: "sample data",
      });
    }
  });

  let n = 5000;
  let orders = 0;
  let payments = 0;
  type Sale = {
    product: Product; quantity?: number; placedDaysAgo: number; currency?: string; country?: string; batchCode?: string | null;
    shippedDaysAgo?: number | null; card?: boolean; returned?: number; unitMinor?: number; doubleCharge?: boolean; service?: boolean;
  };
  async function sell(sale: Sale): Promise<void> {
    n += 1;
    const currency = sale.currency ?? "USD";
    const quantity = sale.quantity ?? 1;
    const unit = sale.unitMinor ?? (currency === "JPY" ? Math.round(sale.product.priceMinor * 1.5) : sale.product.priceMinor);
    const total = unit * quantity;
    const placedAt = daysAgo(sale.placedDaysAgo, n % 600);
    const name = NAMES[n % NAMES.length]!;
    const email = `${name.split(" ")[0]!.toLowerCase()}.${n}@example.com`;
    const makeCapture = () =>
      sim.addCapture({
        amountMinor: total, currency, createdAt: placedAt, payerEmail: email, payerName: name, payerId: `SIMPAYER${n}`,
        payerCountry: sale.country ?? "US", invoiceId: `D-${n}`,
        items: [{ code: sale.product.sku, name: sale.product.title, quantity, unitMinor: unit }],
      });
    const capture = sale.card ? null : makeCapture();
    if (capture) payments++;
    if (sale.doubleCharge) {
      // The checkout charged this customer a second time, two minutes later, for the same order.
      const second = makeCapture();
      second.createdAt = new Date(placedAt.getTime() + 2 * MINUTE);
      payments++;
    }
    const start = sale.service ? placedAt : null;
    const order = OrderImport.parse({
      externalId: `demo-${n}`, orderNumber: `D-${n}`, placedAt: placedAt.toISOString(), currency,
      channel: sale.service ? "subscription" : "online",
      customer: { email, name, isGuest: n % 5 === 0 },
      shippingCountry: sale.country ?? "US",
      paymentMethod: capture ? "paypal" : "card", paymentReference: capture?.id ?? null,
      total: fromMinor(total, currency),
      lines: [{
        externalId: "1", sku: sale.product.sku, title: sale.product.title, quantity, unitPrice: fromMinor(unit, currency),
        kind: sale.service ? "subscription" : "physical",
        serviceStart: start ? start.toISOString() : null,
        serviceEnd: start ? new Date(start.getTime() + 30 * DAY).toISOString() : null,
      }],
      fulfilments: sale.service || sale.shippedDaysAgo === null ? [] : [{
        externalId: "1", shippedAt: daysAgo(sale.shippedDaysAgo ?? sale.placedDaysAgo - 1).toISOString(),
        lines: [{ lineExternalId: "1", quantity, batchCode: sale.batchCode ?? null }],
      }],
      adjustments: sale.returned ? [{ externalId: "r1", kind: "return", lineExternalId: "1", quantity: sale.returned, occurredAt: daysAgo(Math.max(1, sale.placedDaysAgo - 10)).toISOString() }] : [],
      raw: { sample: true },
    });
    await db.tx((tx) => upsertOrder(tx, input.orgId, store!.id, order));
    orders++;
  }

  const [hm300, hm500, kettle, plan] = PRODUCTS as [Product, Product, Product, Product];
  // Affected batch, recorded at packing.
  for (let i = 0; i < 14; i++) await sell({ product: hm300, placedDaysAgo: 39 - i, batchCode: "LOT-24B", quantity: i % 6 === 0 ? 2 : 1 });
  // Shipped while only the affected batch was going out, but nobody wrote the batch down.
  for (let i = 0; i < 5; i++) await sell({ product: hm300, placedDaysAgo: 37 - i, shippedDaysAgo: 36 - i, batchCode: null });
  // Shipped while two batches overlapped: mixed stock.
  for (let i = 0; i < 6; i++) await sell({ product: hm300, placedDaysAgo: 28 - i, shippedDaysAgo: 27 - i, batchCode: null });
  // Other batches: proven not affected.
  for (let i = 0; i < 9; i++) await sell({ product: hm300, placedDaysAgo: 60 - i * 2, batchCode: "LOT-23A" });
  for (let i = 0; i < 7; i++) await sell({ product: hm300, placedDaysAgo: 18 - i * 2, batchCode: "LOT-25C" });
  // Edge cases for the affected batch.
  await sell({ product: hm300, placedDaysAgo: 33, batchCode: "LOT-24B", card: true }); // paid by card
  await sell({ product: hm300, placedDaysAgo: 34, batchCode: "LOT-24B", returned: 1 }); // sent back already
  await sell({ product: hm300, placedDaysAgo: 35, batchCode: "LOT-24B", quantity: 2, returned: 1 }); // kept one of two
  await sell({ product: hm300, placedDaysAgo: 31, shippedDaysAgo: null }); // no shipping record at all
  // Customers abroad, paying in their own currency.
  await sell({ product: hm300, placedDaysAgo: 30, batchCode: "LOT-24B", currency: "EUR", country: "DE" });
  await sell({ product: hm300, placedDaysAgo: 29, batchCode: "LOT-24B", currency: "EUR", country: "FR" });
  await sell({ product: hm300, placedDaysAgo: 28, batchCode: "LOT-24B", currency: "GBP", country: "GB" });
  await sell({ product: hm300, placedDaysAgo: 32, batchCode: "LOT-24B", currency: "JPY", country: "JP" });
  // Other products, for a realistic catalogue.
  for (let i = 0; i < 8; i++) await sell({ product: hm500, placedDaysAgo: 50 - i * 5 });
  for (let i = 0; i < 10; i++) await sell({ product: kettle, placedDaysAgo: 45 - i * 4 });
  // Too old for PayPal to refund the original payment.
  await sell({ product: hm500, placedDaysAgo: 200, batchCode: null });
  // A billing error: the checkout charged three customers twice this week.
  for (let i = 0; i < 3; i++) await sell({ product: kettle, placedDaysAgo: 3 + i, doubleCharge: true });
  // A price mistake: the kettle was sold above its listed price for two days.
  for (let i = 0; i < 4; i++) await sell({ product: kettle, placedDaysAgo: 9 + (i % 2), unitMinor: 4900 });
  // Subscriptions, for a service outage.
  for (let i = 0; i < 6; i++) await sell({ product: plan, placedDaysAgo: 20 - i, service: true });

  const stats = await syncTransactions({ db, clock }, { orgId: input.orgId, connectionId: active.id, provider: sim, from: daysAgo(240), to: now });
  await db.tx(async (tx) => {
    await tx.query(`update organisations set settings = settings || '{"demoData": true}'::jsonb where id = $1`, [input.orgId]);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "demo.seeded", entityType: "organisation",
      entityId: input.orgId, data: { orders, payments: stats.payments }, at: now,
    });
  });
  return { orders, payments, batches: batches.length };
}

/**
 * Loads the flagship test case on a simulator connection: a supplier recall
 * of one batch of the HM-300 hand mixer, with deliberately untidy records and
 * the right answer stored for each. See recall-scenario.ts.
 */
export async function seedRecallScenario(
  deps: { db: Db; clock: Clock; connections: PayPalConnections },
  input: { orgId: string; userId: string },
): Promise<{ incidentId: string; documentId: string; orders: number; payments: number; labels: number; skipped: Array<{ caseTag: string; why: string }> }> {
  const { db, clock, connections } = deps;
  const active = await connections.active(input.orgId);
  if (!active || active.environment !== "simulator") {
    throw new ConflictError("NOT_SIMULATOR", "This sample case can only be loaded here on a simulator connection. To run it on the PayPal sandbox, use `npm run sandbox:recall`.");
  }
  const existing = await db.query("select 1 from commerce_connections where org_id = $1 and name = $2", [input.orgId, RECALL_STORE_NAME]);
  if (existing.length > 0) throw new ConflictError("ALREADY_SEEDED", "The recall case is already loaded for this organisation.");
  const sim = await connections.simulatorFor(input.orgId);
  const now = clock.now();
  const data = await buildRecallScenario({
    mode: "simulator", now, prefix: "#", provider: sim,
    pay: async (request) => {
      const capture = sim.addCapture({
        amountMinor: request.amountMinor, currency: request.currency, createdAt: request.at, invoiceId: request.invoiceId ?? undefined,
        payerEmail: request.payer.email, payerName: request.payer.name, payerId: `SIMPAYER${request.key.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`,
        payerCountry: "US", items: [{ code: request.item.sku, name: request.item.title, quantity: request.item.quantity, unitMinor: request.item.unitMinor }],
      });
      return { captureId: capture.id, createdAt: capture.createdAt };
    },
    openDispute: (captureId) => {
      const capture = sim.captures.get(captureId);
      if (capture) capture.disputed = true;
    },
  });
  const loaded = await loadRecallScenario({ db, clock }, { orgId: input.orgId, userId: input.userId, data });
  const stats = await syncTransactions({ db, clock }, { orgId: input.orgId, connectionId: active.id, provider: sim, from: new Date(now.getTime() - 120 * DAY), to: now });
  return { incidentId: loaded.incidentId, documentId: loaded.documentId, orders: loaded.orders, payments: stats.payments, labels: loaded.labels, skipped: data.skipped };
}
