// The demo shop, "Brightside Kitchen", and one incident: a bad batch of hand mixers.
// The data is generated from a fixed seed, so every run produces the same shop.
// Dates are counted back from today, so the 180-day refund window always behaves as it would live.
//
// Everything created here is SAMPLE data. In mock mode the payments live in the mock PayPal and
// carry MOCK- IDs. Nothing in this file talks to the real PayPal sandbox.
import { fmt, pct } from "./money.ts";
import type { MockPayPal } from "./paypal/mock.ts";

export const SHOP = { name: "Brightside Kitchen", currency: "USD" };

export const CATALOG = [
  { sku: "HM-300", name: "Hand Mixer 300W", cents: 4900 },
  { sku: "HM-350", name: "Hand Mixer 350W", cents: 5900 },
  { sku: "WH-2PK", name: "Whisk attachments (2)", cents: 1200 },
  { sku: "KT-170", name: "Kettle 1.7 L", cents: 3900 },
  { sku: "TS-200", name: "Toaster 2-slice", cents: 3400 },
  { sku: "BL-500", name: "Blender 500 ml", cents: 4500 },
] as const;

const price = (sku: string) => CATALOG.find((p) => p.sku === sku)!.cents;
const nameOf = (sku: string) => CATALOG.find((p) => p.sku === sku)!.name;

const DAY = 86400_000;
export const daysAgo = (n: number, hour = 12) => {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(hour, (n * 7) % 60, 0, 0);
  return d.toISOString();
};

/** The story the demo tells. Batch B-2217 arrived 95 days ago and shipped between days 92 and 64. */
export const DEMO_INCIDENT = {
  sku: "HM-300",
  batch: "B-2217",
  shipFrom: daysAgo(92, 0),
  shipTo: daysAgo(64, 23),
  paidFrom: daysAgo(205, 0),
  description:
    "Our supplier told us that hand mixer HM-300 from batch B-2217 has a faulty motor that can overheat. " +
    `That batch shipped to customers between ${daysAgo(92).slice(0, 10)} and ${daysAgo(64).slice(0, 10)}. ` +
    "Refund the full price of the mixer to everyone who received one from that batch. Do not refund other items in the order or shipping.",
};

export interface DemoLine {
  sku: string;
  qty: number;
  unitCents: number;
  discountCents: number;
}
export interface DemoOrder {
  orderNumber: string;
  email: string;
  name: string;
  paidAt: string;
  lines: DemoLine[];
  totalCents: number;
  shippedAt: string | null;
  batchCode: string | null;
  paidVia: "paypal" | "other-gateway";
  group: string;
  /** How the payment was recorded at PayPal. */
  paypal?: { invoiceId: boolean; hideItems: boolean };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Asha", "Liam", "Mei", "Omar", "Sofia", "Noah", "Priya", "Lucas", "Zara", "Ethan", "Ines", "Kofi", "Hana", "Mateo", "Ruth", "Arjun", "Elena", "Tariq", "Nora", "Felix", "Yuki", "Dara", "Ivan", "Leila", "Marco"];
const LAST = ["Rao", "Chen", "Okafor", "Silva", "Haddad", "Novak", "Mehta", "Garcia", "Kim", "Osei", "Larsen", "Costa", "Ito", "Bauer", "Khan", "Reyes", "Petrov", "Moreau", "Singh", "Tan", "Abadi", "Lopez", "Weiss", "Farah", "Dubois"];

export function buildDemoOrders(seed = 2217): DemoOrder[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const orders: DemoOrder[] = [];
  let n = 1000;

  const make = (group: string, shipDay: number | null, batch: string | null, paidDay?: number): DemoOrder => {
    const first = pick(FIRST);
    const last = pick(LAST);
    const num = ++n;
    const lines: DemoLine[] = [{ sku: "HM-300", qty: 1, unitCents: price("HM-300"), discountCents: 0 }];
    if (rnd() < 0.15) lines.push({ sku: "WH-2PK", qty: 1, unitCents: price("WH-2PK"), discountCents: 0 });
    if (rnd() < 0.1) for (const l of lines) l.discountCents = pct(l.unitCents * l.qty, 10);
    const total = lines.reduce((s, l) => s + l.unitCents * l.qty - l.discountCents, 0);
    const paid = paidDay ?? (shipDay === null ? between(100, 12) : shipDay + between(1, 3));
    return {
      orderNumber: `BK-${num}`,
      email: `${first}.${last}${num}@example.com`.toLowerCase(),
      name: `${first} ${last}`,
      paidAt: daysAgo(paid, between(8, 20)),
      lines,
      totalCents: total,
      shippedAt: shipDay === null ? null : daysAgo(shipDay, 10),
      batchCode: batch,
      paidVia: "paypal",
      group,
      paypal: { invoiceId: rnd() >= 0.05, hideItems: rnd() < 0.2 },
    };
  };

  // A: batch scanned at packing, bad batch -> level 1
  for (let i = 0; i < 212; i++) orders.push(make("A", between(64, 92), "B-2217"));
  // B: batch scanned, a different batch -> not affected
  for (let i = 0; i < 45; i++) orders.push(make("B", between(93, 108), "B-2101"));
  for (let i = 0; i < 45; i++) orders.push(make("B", between(10, 63), "B-2290"));
  // C: no scan, shipped inside the bad batch's window -> level 2 (likely)
  for (let i = 0; i < 128; i++) orders.push(make("C", between(64, 92), null));
  // D: no scan, shipped outside the window -> not affected
  for (let i = 0; i < 50; i++) orders.push(make("D", rnd() < 0.5 ? between(93, 108) : between(10, 63), null));
  // E: no scan and no ship date recorded -> level 3 (product only)
  for (let i = 0; i < 30; i++) orders.push(make("E", null, null));
  // G: pre-orders paid more than 180 days ago, shipped from the bad batch -> level 1, but too old to refund
  for (let i = 0; i < 4; i++) orders.push(make("G", between(70, 90), "B-2217", between(190, 200)));

  // Eight customers in A and C paid through another gateway: no PayPal payment exists.
  for (const o of [...orders.filter((o) => o.group === "A").slice(0, 5), ...orders.filter((o) => o.group === "C").slice(0, 3)]) {
    o.paidVia = "other-gateway";
    o.paypal = undefined;
  }

  // Other products: never affected. HM-350 has a confusingly similar name on purpose.
  const others = ["HM-350", "KT-170", "TS-200", "BL-500", "WH-2PK"];
  for (let i = 0; i < 80; i++) {
    const sku = pick(others);
    const first = pick(FIRST);
    const last = pick(LAST);
    const num = ++n;
    const qty = rnd() < 0.1 ? 2 : 1;
    orders.push({
      orderNumber: `BK-${num}`,
      email: `${first}.${last}${num}@example.com`.toLowerCase(),
      name: `${first} ${last}`,
      paidAt: daysAgo(between(8, 108), between(8, 20)),
      lines: [{ sku, qty, unitCents: price(sku), discountCents: 0 }],
      totalCents: price(sku) * qty,
      shippedAt: daysAgo(between(5, 100), 10),
      batchCode: null,
      paidVia: "paypal",
      group: "other",
      paypal: { invoiceId: true, hideItems: false },
    });
  }
  return orders;
}

const CSV_HEAD = "order_number,email,customer_name,paid_at,sku,item_name,qty,unit_price,line_discount,order_total,shipped_at,batch_code,paid_via";

/** The shop's order export, as the merchant would upload it. One row per order line. */
export function ordersToCsv(orders: DemoOrder[]): string {
  const rows = [CSV_HEAD];
  for (const o of orders)
    for (const l of o.lines)
      rows.push(
        [o.orderNumber, o.email, `"${o.name}"`, o.paidAt, l.sku, `"${nameOf(l.sku)}"`, l.qty, fmt(l.unitCents), fmt(l.discountCents), fmt(o.totalCents), o.shippedAt ?? "", o.batchCode ?? "", o.paidVia].join(","),
      );
  return rows.join("\n");
}

export interface SeedSummary {
  orders: number;
  payments: number;
  paypalOnlyPayments: number;
  duplicateCharges: number;
  note: string;
}

/** Put the demo shop's payments into the mock PayPal, including the awkward cases. */
export async function seedMock(mock: MockPayPal, orders: DemoOrder[]): Promise<SeedSummary> {
  mock.reset();
  let payments = 0;
  const captureOf = new Map<string, string>();
  for (const o of orders) {
    if (!o.paypal) continue;
    const id = mock.seedPayment({
      payerEmail: o.email,
      payerName: o.name,
      amountCents: o.totalCents,
      invoiceId: o.paypal.invoiceId ? o.orderNumber : undefined,
      paidAt: o.paidAt,
      hideItems: o.paypal.hideItems,
      items: o.lines.map((l) => ({ sku: l.sku, name: nameOf(l.sku), qty: l.qty, unitCents: l.unitCents - Math.round(l.discountCents / l.qty) })),
    });
    captureOf.set(o.orderNumber, id);
    payments++;
  }

  const groupA = orders.filter((o) => o.group === "A" && o.paypal && o.lines.length === 1 && o.lines[0].discountCents === 0);
  // One customer already returned the mixer and was refunded in full.
  await mock.refundCapture(captureOf.get(groupA[10].orderNumber)!, "seed-full-refund");
  // One customer already got a $10 goodwill refund.
  await mock.refundCapture(captureOf.get(groupA[11].orderNumber)!, "seed-part-refund", { currency_code: "USD", value: "10.00" });
  // One customer has already opened a dispute.
  mock.seedDispute(captureOf.get(groupA[12].orderNumber)!);

  // F: six PayPal payments with no item details and no order in the export -> level 4 (amount and date only)
  for (let i = 0; i < 6; i++) {
    mock.seedPayment({ payerEmail: `walkin${i + 1}@example.com`, payerName: `Walk-in Customer ${i + 1}`, amountCents: price("HM-300"), paidAt: daysAgo(66 + i * 4, 15), hideItems: true });
    payments++;
  }

  // Two customers were charged twice within minutes (found by the duplicate-charge scan).
  const dupes = orders.filter((o) => o.group === "other").slice(0, 2);
  for (const o of dupes) {
    const again = new Date(Date.parse(o.paidAt) + 3 * 60_000).toISOString();
    mock.seedPayment({ payerEmail: o.email, payerName: o.name, amountCents: o.totalCents, paidAt: again, items: o.lines.map((l) => ({ sku: l.sku, name: nameOf(l.sku), qty: l.qty, unitCents: l.unitCents })) });
    payments++;
  }

  return {
    orders: orders.length,
    payments,
    paypalOnlyPayments: 6,
    duplicateCharges: dupes.length,
    note: "SAMPLE data in the MOCK PayPal. No real PayPal records were created.",
  };
}
