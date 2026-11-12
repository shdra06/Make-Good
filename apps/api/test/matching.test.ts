import assert from "node:assert/strict";
import { test } from "node:test";
import { runMatch } from "../src/modules/matching/engine.ts";
import { IncidentScope, type CandidateDraft, type MatchInput } from "../src/modules/matching/types.ts";
import { adjustment, at, batch, fulfilment, line, order, paidOrder, payment } from "./fixtures.ts";

const NOW = at("2026-10-01");

function recall(extra: Record<string, unknown> = {}) {
  return IncidentScope.parse({ type: "product", skus: ["CM-412"], batchCodes: ["LOT-24B"], ...extra });
}

function match(input: Partial<MatchInput> & { scope: MatchInput["scope"] }) {
  return runMatch({ now: NOW, orders: [], payments: [], batches: [], ...input });
}

const proposed = (cs: CandidateDraft[]) => cs.filter((c) => c.status === "proposed");

test("a batch code recorded at packing identifies the exact unit", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "lot 24b" })] })] });
  const { candidates } = match({ scope: recall(), orders: [o], payments: [p] });
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.classification, "exact_unit");
  assert.equal(c.needsConfirmation, false);
  assert.equal(c.recommendedAction, "pay");
  assert.equal(c.paymentId, p.id);
  assert.ok(c.evidence.some((e) => e.source === "fulfilment_line" && e.strength === "proves"), "names the packing record");
  assert.ok(c.evidence.some((e) => e.source === "order_payment_link" && e.strength === "proves"), "names the payment link");
});

test("a different recorded batch clears the customer, and is counted", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-23A" })] })] });
  const { candidates, stats } = match({ scope: recall(), orders: [o], payments: [p] });
  assert.equal(candidates.length, 0);
  assert.equal(stats.clearedByBatchRecord, 1);
});

test("a similar product with a different SKU is never matched", () => {
  const { order: o, payment: p } = paidOrder({
    lines: [line({ sku: "CM-412-RED", fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] }), line({ sku: "CM-41" })],
  });
  assert.equal(match({ scope: recall(), orders: [o], payments: [p] }).candidates.length, 0);
});

test("no batch code, but inventory shows only the affected batch was shipping: strong, needs merchant review", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-09-10") })] })] });
  const batches = [
    batch({ batchCode: "LOT-24B", firstShippedAt: at("2026-09-05"), lastShippedAt: at("2026-09-15") }),
    batch({ batchCode: "LOT-23A", firstShippedAt: at("2026-08-01"), lastShippedAt: at("2026-09-01") }),
  ];
  const c = match({ scope: recall(), orders: [o], payments: [p], batches }).candidates[0]!;
  assert.equal(c.classification, "strong_multi_source");
  assert.equal(c.needsConfirmation, true);
  assert.equal(c.recommendedAction, "merchant_review");
  assert.ok(c.evidence.some((e) => e.source === "inventory_batch"));
  assert.ok(c.missing.some((m) => /No batch code/.test(m)));
});

test("mixed stock is only 'likely': a ship date cannot prove the batch", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-09-10") })] })] });
  const batches = [
    batch({ batchCode: "LOT-24B", firstShippedAt: at("2026-09-05"), lastShippedAt: at("2026-09-15") }),
    batch({ batchCode: "LOT-23A", firstShippedAt: at("2026-08-20"), lastShippedAt: at("2026-09-12") }),
  ];
  const c = match({ scope: recall(), orders: [o], payments: [p], batches }).candidates[0]!;
  assert.equal(c.classification, "likely");
  assert.equal(c.recommendedAction, "ask_customer");
  assert.ok(c.evidence.some((e) => e.strength === "contradicts"), "records the unaffected batch as contrary evidence");
});

test("inventory showing only unaffected stock clears the order", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-08-10") })] })] });
  const batches = [
    batch({ batchCode: "LOT-24B", firstShippedAt: at("2026-09-05"), lastShippedAt: at("2026-09-15") }),
    batch({ batchCode: "LOT-23A", firstShippedAt: at("2026-08-01"), lastShippedAt: at("2026-09-01") }),
  ];
  const { candidates, stats } = match({ scope: recall(), orders: [o], payments: [p], batches });
  assert.equal(candidates.length, 0);
  assert.equal(stats.clearedByInventory, 1);
});

test("with only the merchant's ship window, a match is 'likely' and the evidence is marked weak", () => {
  const scope = recall({ shippedFrom: "2026-09-05T00:00:00Z", shippedTo: "2026-09-15T23:59:59Z" });
  const inside = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-09-10") })] })] });
  const outside = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-09-20") })] })] });
  const { candidates, stats } = match({ scope, orders: [inside.order, outside.order], payments: [inside.payment, outside.payment] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.classification, "likely");
  assert.ok(candidates[0]!.evidence.some((e) => e.strength === "weak"));
  assert.equal(stats.clearedByShipWindow, 1);
});

test("no batch, no ship date, no inventory: product-level only", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line()] });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.equal(c.classification, "product_only");
  assert.equal(c.needsConfirmation, true);
  assert.equal(c.recommendedAction, "ask_customer");
});

test("three units in one line, one from the affected batch: one unit is compensated", () => {
  const { order: o, payment: p } = paidOrder({
    lines: [line({ quantity: 3, fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" }), fulfilment({ quantity: 2, batchCode: "LOT-23A" })] })],
  });
  const { candidates, stats } = match({ scope: recall(), orders: [o], payments: [p] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.affectedQuantity, 1);
  assert.equal(stats.clearedByBatchRecord, 2);
});

test("units documented differently in one line become separate candidates", () => {
  const { order: o, payment: p } = paidOrder({
    lines: [line({ quantity: 3, fulfilments: [fulfilment({ quantity: 2, batchCode: "LOT-24B" }), fulfilment({ quantity: 1, shippedAt: null })] })],
  });
  const cs = match({ scope: recall(), orders: [o], payments: [p] }).candidates;
  assert.deepEqual(cs.map((c) => [c.classification, c.affectedQuantity]).sort(), [["exact_unit", 2], ["product_only", 1]]);
  assert.notEqual(cs[0]!.subjectKey, cs[1]!.subjectKey);
});

test("a partial return reduces the affected quantity; a full return excludes", () => {
  const partial = paidOrder({
    lines: [line({ quantity: 2, fulfilments: [fulfilment({ quantity: 2, batchCode: "LOT-24B" })], adjustments: [adjustment({ kind: "return", quantity: 1 })] })],
  });
  const full = paidOrder({
    lines: [line({ quantity: 1, fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })], adjustments: [adjustment({ kind: "return", quantity: 1 })] })],
  });
  const cs = match({ scope: recall(), orders: [partial.order, full.order], payments: [partial.payment, full.payment] }).candidates;
  const a = cs.find((c) => c.orderId === partial.order.id)!;
  assert.equal(a.affectedQuantity, 1);
  assert.ok(a.reasons.some((r) => /returned/.test(r)));
  const b = cs.find((c) => c.orderId === full.order.id)!;
  assert.equal(b.status, "excluded");
  assert.equal(b.exclusionCode, "returned");
});

test("a replacement needs a person: the new unit may be from another batch", () => {
  const { order: o, payment: p } = paidOrder({
    lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })], adjustments: [adjustment({ kind: "replacement", quantity: 1 })] })],
  });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.equal(c.needsConfirmation, true);
  assert.equal(c.recommendedAction, "merchant_review");
});

test("already refunded and disputed payments are excluded with the reason", () => {
  const refunded = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] }, { refundedMinor: 5900 });
  const disputed = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] }, { disputeState: "open" });
  const { candidates, stats } = match({ scope: recall(), orders: [refunded.order, disputed.order], payments: [refunded.payment, disputed.payment] });
  assert.equal(proposed(candidates).length, 0);
  assert.equal(stats.excluded.already_refunded, 1);
  assert.equal(stats.excluded.dispute_open, 1);
  assert.equal(candidates.find((c) => c.exclusionCode === "dispute_open")!.recommendedAction, "resolve_dispute");
});

test("an order paid outside PayPal is still an affected customer, with no payment to refund", () => {
  const o = order({ paymentMethod: "card", lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] });
  const c = match({ scope: recall(), orders: [o] }).candidates[0]!;
  assert.equal(c.classification, "exact_unit");
  assert.equal(c.paymentId, null);
  assert.equal(c.recommendedAction, "pay_outside_paypal");
});

test("a guessed order-to-payment link must be confirmed before money moves", () => {
  const o = order({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] });
  const p = payment({ grossMinor: o.totalMinor });
  o.paymentLinks.push({ paymentId: p.id, method: "heuristic", strength: "heuristic", detail: "same email, amount and minute" });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.equal(c.classification, "exact_unit", "the unit is proven");
  assert.equal(c.needsConfirmation, true, "but the payment is not");
  assert.equal(c.recommendedAction, "confirm_payment_link");
});

test("a PayPal order with no payment found is flagged, not silently paid", () => {
  const o = order({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] });
  const c = match({ scope: recall(), orders: [o] }).candidates[0]!;
  assert.equal(c.recommendedAction, "confirm_payment_link");
  assert.ok(c.missing.some((m) => /No PayPal payment/.test(m)));
});

test("guest checkout: the payer on the PayPal payment identifies the customer", () => {
  const { order: o, payment: p } = paidOrder(
    { customerEmail: null, customerName: null, isGuest: true, lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] },
    { payerEmail: "guest@example.com", payerName: "G. Guest" },
  );
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.equal(c.customerEmail, "guest@example.com");
});

test("the same customer buying twice gives two separate candidates", () => {
  const a = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] });
  const b = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] });
  const cs = match({ scope: recall(), orders: [a.order, b.order], payments: [a.payment, b.payment] }).candidates;
  assert.equal(cs.length, 2);
  assert.equal(new Set(cs.map((c) => c.subjectKey)).size, 2);
  assert.equal(new Set(cs.map((c) => c.paymentId)).size, 2);
});

test("serial numbers recorded at packing identify exact units", () => {
  const scope = IncidentScope.parse({ type: "product", skus: ["CM-412"], serials: ["SN-0042", "SN-0043"] });
  const { order: o, payment: p } = paidOrder({ lines: [line({ quantity: 2, fulfilments: [fulfilment({ quantity: 2, serials: ["sn0042", "SN-0099"] })] })] });
  const { candidates, stats } = match({ scope, orders: [o], payments: [p] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.affectedQuantity, 1);
  assert.equal(candidates[0]!.classification, "exact_unit");
  assert.equal(stats.clearedByBatchRecord, 1);
});

test("a whole-product incident (no batch) is exact from the order line alone", () => {
  const scope = IncidentScope.parse({ type: "product", skus: ["TICKET-GA"], orderedFrom: "2026-09-01T00:00:00Z", orderedTo: "2026-09-30T00:00:00Z" });
  const inside = paidOrder({ lines: [line({ sku: "ticket-ga", kind: "ticket", quantity: 2 })] });
  const before = paidOrder({ placedAt: at("2026-08-15"), lines: [line({ sku: "TICKET-GA", kind: "ticket" })] });
  const { candidates, stats } = match({ scope, orders: [inside.order, before.order], payments: [inside.payment, before.payment] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.classification, "exact_unit");
  assert.equal(candidates[0]!.affectedQuantity, 2);
  assert.equal(stats.outsideOrderWindow, 1);
});

test("a PayPal payment with no store order is a weak, transaction-only candidate", () => {
  const known = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "LOT-24B" })] })] });
  const named = payment({ payerEmail: "a@example.com", items: [{ code: "cm-412", name: "Mug set", quantity: 1, unitMinor: 5900 }] });
  const amountOnly = payment({ payerEmail: "b@example.com", grossMinor: 5900 });
  const unrelated = payment({ payerEmail: "c@example.com", grossMinor: 1234 });
  const cs = match({ scope: recall(), orders: [known.order], payments: [known.payment, named, amountOnly, unrelated] }).candidates;
  const loose = cs.filter((c) => c.classification === "transaction_only");
  assert.equal(loose.length, 2);
  assert.ok(loose.every((c) => c.needsConfirmation && c.recommendedAction === "ask_customer"));
  assert.equal(loose.find((c) => c.paymentId === named.id)!.evidence[0]!.strength, "supports");
  assert.equal(loose.find((c) => c.paymentId === amountOnly.id)!.evidence[0]!.strength, "weak");
});

// ---------- duplicate charges ----------

const dupScope = IncidentScope.parse({ type: "duplicate_charge", from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z", windowMinutes: 10 });

test("one order paid twice is a proven duplicate", () => {
  const { order: o, payment: first } = paidOrder({ lines: [line()] }, { occurredAt: at("2026-09-08T10:00:00Z"), payerId: "P1" });
  const second = payment({ occurredAt: at("2026-09-08T10:02:00Z"), payerId: "P1", grossMinor: first.grossMinor, invoiceId: first.invoiceId });
  const { candidates } = match({ scope: dupScope, orders: [o], payments: [first, second] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.paymentId, second.id, "the later payment is the duplicate");
  assert.equal(candidates[0]!.classification, "exact_unit");
  assert.equal(candidates[0]!.needsConfirmation, false);
});

test("two payments with their own orders are a customer buying twice, not a duplicate", () => {
  const a = paidOrder({ lines: [line()] }, { occurredAt: at("2026-09-08T10:00:00Z"), payerId: "P1" });
  const b = paidOrder({ lines: [line()] }, { occurredAt: at("2026-09-08T10:03:00Z"), payerId: "P1" });
  const { candidates, stats } = match({ scope: dupScope, orders: [a.order, b.order], payments: [a.payment, b.payment] });
  assert.equal(candidates.length, 0);
  assert.equal(stats.legitimateRepeatPurchases, 1);
});

test("duplicates need the same payer, amount and a short gap", () => {
  const base = { payerId: "P1", grossMinor: 5900 };
  const first = payment({ ...base, occurredAt: at("2026-09-08T10:00:00Z") });
  const late = payment({ ...base, occurredAt: at("2026-09-08T11:00:00Z") });
  const otherPayer = payment({ ...base, payerId: "P2", occurredAt: at("2026-09-08T10:01:00Z") });
  const otherAmount = payment({ ...base, grossMinor: 6000, occurredAt: at("2026-09-08T10:01:00Z") });
  assert.equal(match({ scope: dupScope, payments: [first, late, otherPayer, otherAmount] }).candidates.length, 0);
});

test("with no order data a repeat payment is only 'likely' and needs review", () => {
  const first = payment({ payerId: "P1", occurredAt: at("2026-09-08T10:00:00Z") });
  const second = payment({ payerId: "P1", occurredAt: at("2026-09-08T10:01:00Z") });
  const c = match({ scope: dupScope, payments: [first, second] }).candidates[0]!;
  assert.equal(c.classification, "likely");
  assert.equal(c.needsConfirmation, true);
  assert.equal(c.recommendedAction, "merchant_review");
});

test("three identical charges give two duplicates", () => {
  const { order: o, payment: first } = paidOrder({ lines: [line()] }, { occurredAt: at("2026-09-08T10:00:00Z"), payerId: "P1" });
  const more = [1, 2].map((m) => payment({ occurredAt: at(`2026-09-08T10:0${m}:00Z`), payerId: "P1", grossMinor: first.grossMinor, invoiceId: first.invoiceId }));
  assert.equal(match({ scope: dupScope, orders: [o], payments: [first, ...more] }).candidates.length, 2);
});

// ---------- overcharge and service period ----------

test("an overcharge is the difference per unit, on the units not returned", () => {
  const scope = IncidentScope.parse({ type: "overcharge", sku: "CM-412", correctUnitPriceMinor: 4900, from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
  const over = paidOrder({ lines: [line({ quantity: 2, unitPriceMinor: 5900 })] });
  const right = paidOrder({ lines: [line({ unitPriceMinor: 4900 })] });
  const cs = match({ scope, orders: [over.order, right.order], payments: [over.payment, right.payment] }).candidates;
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.facts.overchargePerUnitMinor, 1000);
  assert.equal(cs[0]!.affectedQuantity, 2);
  assert.equal(cs[0]!.classification, "exact_unit");
});

test("a service outage matches only the paid periods that overlap it", () => {
  const scope = IncidentScope.parse({ type: "service_period", skus: ["PLAN-PRO"], outageStart: "2026-09-10T00:00:00Z", outageEnd: "2026-09-13T00:00:00Z" });
  const sub = (start: string, end: string) =>
    paidOrder({ lines: [line({ sku: "PLAN-PRO", kind: "subscription", unitPriceMinor: 3000, serviceStart: at(start), serviceEnd: at(end) })] });
  const overlapping = sub("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");
  const before = sub("2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
  const noPeriod = paidOrder({ lines: [line({ sku: "PLAN-PRO", kind: "subscription", unitPriceMinor: 3000 })] });
  const cs = match({
    scope,
    orders: [overlapping.order, before.order, noPeriod.order],
    payments: [overlapping.payment, before.payment, noPeriod.payment],
  }).candidates;
  assert.equal(cs.length, 2);
  const exact = cs.find((c) => c.orderId === overlapping.order.id)!;
  assert.equal(exact.facts.serviceSecondsAffected, 3 * 86400);
  assert.equal(exact.facts.serviceSecondsTotal, 30 * 86400);
  assert.equal(cs.find((c) => c.orderId === noPeriod.order.id)!.classification, "product_only");
});
