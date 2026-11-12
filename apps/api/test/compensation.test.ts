import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCompensation, CompensationRule, lineValue, type CompensationInput } from "../src/modules/compensation/engine.ts";
import type { OrderLineRecord, OrderRecord, PaymentRecord } from "../src/modules/matching/types.ts";
import { adjustment, at, line, order, paidOrder, payment } from "./fixtures.ts";

const NOW = at("2026-10-01");

function calc(
  rule: Record<string, unknown>,
  o: OrderRecord | null,
  l: OrderLineRecord | null,
  p: PaymentRecord | null,
  extra: Partial<CompensationInput["candidate"]> & { payoutsAvailable?: boolean; now?: Date } = {},
) {
  const { payoutsAvailable = true, now = NOW, ...candidate } = extra;
  return calculateCompensation({
    rule: CompensationRule.parse(rule),
    now,
    candidate: {
      affectedQuantity: l?.quantity ?? 1,
      classification: "exact_unit",
      facts: {},
      customerEmail: o?.customerEmail ?? null,
      ...candidate,
    },
    order: o,
    line: l,
    payment: p,
    payoutsAvailable,
  });
}

test("full refund of a single-line order returns the line, to the original payment", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ unitPriceMinor: 5900, taxMinor: 472 })] });
  const r = calc({ type: "full_refund" }, o, o.lines[0]!, p);
  assert.equal(r.entitlementMinor, 6372);
  assert.equal(r.payableMinor, 6372);
  assert.equal(r.route, "refund_original");
  assert.equal(r.currency, "USD");
  assert.equal(r.steps.at(-1)!.label, "To pay");
});

test("order discount, tax and shipping are spread across lines and add back up exactly", () => {
  const lines = [line({ sku: "A", unitPriceMinor: 3333, quantity: 1 }), line({ sku: "B", unitPriceMinor: 3333, quantity: 1 }), line({ sku: "C", unitPriceMinor: 3334, quantity: 1 })];
  const o = order({ lines, discountMinor: 1000, taxMinor: 721, shippingMinor: 500 });
  const rule = { includeTax: true, includeShipping: true };
  const values = lines.map((l) => lineValue(o, l, rule));
  assert.equal(values.reduce((a, v) => a + v.netMinor, 0), 10000 - 1000, "net of discount");
  assert.equal(values.reduce((a, v) => a + v.taxMinor, 0), 721, "all the tax, no more");
  assert.equal(values.reduce((a, v) => a + v.shippingMinor, 0), 500, "all the shipping, no more");
  assert.equal(values.reduce((a, v) => a + v.netMinor + v.taxMinor + v.shippingMinor, 0), o.totalMinor);
});

test("refunding every line in full never exceeds the order total (many shapes)", () => {
  let seed = 7;
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 200; i++) {
    const lines = Array.from({ length: 1 + rand(5) }, () => line({ quantity: 1 + rand(4), unitPriceMinor: 1 + rand(20000) }));
    const subtotal = lines.reduce((a, l) => a + l.unitPriceMinor * l.quantity, 0);
    const o = order({ lines, discountMinor: rand(Math.max(1, Math.floor(subtotal / 2))), taxMinor: rand(3000), shippingMinor: rand(2000) });
    const p = payment({ grossMinor: o.totalMinor });
    const total = lines.reduce((a, l) => a + calc({ type: "full_refund", includeShipping: true }, o, l, p).entitlementMinor, 0);
    assert.equal(total, o.totalMinor, `order ${i}`);
  }
});

test("part of a line: 1 of 3 units, rounded once", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ quantity: 3, unitPriceMinor: 3333 })] });
  const r = calc({ type: "full_refund" }, o, o.lines[0]!, p, { affectedQuantity: 1 });
  assert.equal(r.entitlementMinor, 3333);
  const odd = paidOrder({ lines: [line({ quantity: 3, unitPriceMinor: 1000, discountMinor: 100 })] });
  assert.equal(calc({ type: "full_refund" }, odd.order, odd.order.lines[0]!, odd.payment, { affectedQuantity: 1 }).entitlementMinor, 967, "2900 / 3 = 966.67");
  assert.equal(calc({ type: "full_refund", rounding: "down" }, odd.order, odd.order.lines[0]!, odd.payment, { affectedQuantity: 1 }).entitlementMinor, 966);
});

test("percentage and fixed rules", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ quantity: 2, unitPriceMinor: 5900 })] });
  assert.equal(calc({ type: "percent", percentBps: 2500 }, o, o.lines[0]!, p).entitlementMinor, 2950);
  assert.equal(calc({ type: "fixed_per_unit", fixedMinor: 1500, fixedCurrency: "USD" }, o, o.lines[0]!, p).entitlementMinor, 3000);
  assert.equal(calc({ type: "fixed_per_customer", fixedMinor: 1500, fixedCurrency: "USD" }, o, o.lines[0]!, p).entitlementMinor, 1500);
});

test("minimum and maximum limits are applied and shown", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ unitPriceMinor: 5900 })] });
  const capped = calc({ type: "full_refund", maxMinor: 2500 }, o, o.lines[0]!, p);
  assert.equal(capped.payableMinor, 2500);
  assert.ok(capped.steps.some((s) => s.label === "Capped at the maximum"));
  const raised = calc({ type: "percent", percentBps: 500, minMinor: 1000 }, o, o.lines[0]!, p);
  assert.equal(raised.payableMinor, 1000);
  assert.throws(() => CompensationRule.parse({ type: "full_refund", minMinor: 500, maxMinor: 100 }));
});

test("an earlier refund on the line reduces what is paid, never below zero", () => {
  const l = line({ unitPriceMinor: 5900, adjustments: [adjustment({ kind: "store_refund", amountMinor: 2000 })] });
  const { order: o, payment: p } = paidOrder({ lines: [l] }, { refundedMinor: 2000 });
  const r = calc({ type: "full_refund" }, o, l, p);
  assert.equal(r.entitlementMinor, 5900);
  assert.equal(r.alreadyRefundedMinor, 2000);
  assert.equal(r.payableMinor, 3900);
  const all = line({ unitPriceMinor: 5900, adjustments: [adjustment({ kind: "store_refund", amountMinor: 5900 })] });
  const done = paidOrder({ lines: [all] }, { refundedMinor: 5900 });
  const none = calc({ type: "full_refund" }, done.order, all, done.payment);
  assert.equal(none.payableMinor, 0);
  assert.equal(none.route, "none");
});

test("the payment's remaining balance is a hard ceiling", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ unitPriceMinor: 5900 })] }, { refundedMinor: 5000 });
  const r = calc({ type: "full_refund" }, o, o.lines[0]!, p);
  assert.equal(r.payableMinor, 900);
  assert.ok(r.steps.some((s) => s.label === "Limited by the payment"));
});

test("pro-rata service credit", () => {
  const l = line({ sku: "PLAN-PRO", kind: "subscription", unitPriceMinor: 3000 });
  const { order: o, payment: p } = paidOrder({ lines: [l] });
  const r = calc({ type: "pro_rata" }, o, l, p, { facts: { serviceSecondsAffected: 3 * 86400, serviceSecondsTotal: 30 * 86400 } });
  assert.equal(r.entitlementMinor, 300);
  assert.equal(calc({ type: "pro_rata" }, o, l, p).route, "manual", "no period recorded: a person decides");
});

test("overcharge difference with its share of tax", () => {
  const l = line({ quantity: 2, unitPriceMinor: 5900, taxMinor: 944 });
  const { order: o, payment: p } = paidOrder({ lines: [l] });
  const r = calc({ type: "overcharge_difference" }, o, l, p, { facts: { overchargePerUnitMinor: 1000 } });
  assert.equal(r.entitlementMinor, 2000 + 160, "2000 overcharge + 944 x 2000/11800 tax");
  assert.equal(calc({ type: "overcharge_difference", includeTax: false }, o, l, p, { facts: { overchargePerUnitMinor: 1000 } }).entitlementMinor, 2000);
});

test("a duplicate payment is refunded whole", () => {
  const p = payment({ grossMinor: 8425 });
  const r = calc({ type: "duplicate_payment" }, null, null, p);
  assert.equal(r.payableMinor, 8425);
  assert.equal(r.route, "refund_original");
});

test("zero-decimal currency stays whole", () => {
  const l = line({ quantity: 3, unitPriceMinor: 1000 });
  const { order: o, payment: p } = paidOrder({ currency: "JPY", lines: [l] });
  const r = calc({ type: "percent", percentBps: 3333 }, o, l, p);
  assert.equal(r.currency, "JPY");
  assert.equal(r.entitlementMinor, 1000, "3000 x 33.33% = 999.9 yen, rounded to 1000");
});

test("a refund is never converted between currencies", () => {
  const { order: o, payment: p } = paidOrder({ currency: "EUR", lines: [line()] });
  const r = calc({ type: "fixed_per_customer", fixedMinor: 1000, fixedCurrency: "USD" }, o, o.lines[0]!, p);
  assert.equal(r.route, "manual");
  assert.match(r.routeReason, /currency of the original payment/);
});

test("past the refund window: payout if allowed, otherwise a person", () => {
  const old = paidOrder({ placedAt: at("2026-01-01"), lines: [line()] });
  const payout = calc({ type: "full_refund", allowPayout: true }, old.order, old.order.lines[0]!, old.payment);
  assert.equal(payout.route, "payout");
  assert.deepEqual(payout.recipient, { type: "PAYPAL_ID", value: old.payment.payerId });
  assert.equal(calc({ type: "full_refund" }, old.order, old.order.lines[0]!, old.payment).route, "manual");
  assert.equal(calc({ type: "full_refund", allowPayout: true }, old.order, old.order.lines[0]!, old.payment, { payoutsAvailable: false }).route, "manual");
  const day180 = paidOrder({ placedAt: at("2026-04-04"), lines: [line()] });
  assert.equal(calc({ type: "full_refund" }, day180.order, day180.order.lines[0]!, day180.payment).route, "refund_original", "exactly 180 days is still inside");
});

test("no PayPal payment: payout to the customer's email when allowed", () => {
  const o = order({ paymentMethod: "card", lines: [line()] });
  const r = calc({ type: "full_refund", allowPayout: true }, o, o.lines[0]!, null);
  assert.equal(r.route, "payout");
  assert.deepEqual(r.recipient, { type: "EMAIL", value: "pat@example.com" });
  assert.equal(calc({ type: "full_refund" }, o, o.lines[0]!, null).route, "manual");
});

test("a bundle component with no price of its own is sent to a person", () => {
  const parent = line({ sku: "KIT", unitPriceMinor: 9900 });
  const part = line({ sku: "CM-412", unitPriceMinor: 0, parentLineId: parent.id });
  const { order: o, payment: p } = paidOrder({ lines: [parent, part] });
  assert.equal(calc({ type: "full_refund" }, o, part, p).route, "manual");
  assert.equal(calc({ type: "fixed_per_unit", fixedMinor: 2000, fixedCurrency: "USD" }, o, part, p).payableMinor, 2000, "a fixed amount still works");
});

test("the same inputs give the same hash; a changed payment changes it", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line()] });
  const a = calc({ type: "full_refund" }, o, o.lines[0]!, p);
  const b = calc({ type: "full_refund" }, o, o.lines[0]!, p);
  assert.equal(a.inputsHash, b.inputsHash);
  const c = calc({ type: "full_refund" }, o, o.lines[0]!, { ...p, refundedMinor: 100 });
  assert.notEqual(a.inputsHash, c.inputsHash);
});
