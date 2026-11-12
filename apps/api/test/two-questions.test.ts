// The matching engine answers two questions separately:
//   1. does this PayPal payment belong to this order (payment identity)?
//   2. does the evidence show this purchase was affected (eligibility)?
// These tests pin down each answer, the table that combines them, and the
// rule that PayPal's data alone never proves which batch a customer received.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertUnitProof, runMatch } from "../src/modules/matching/engine.ts";
import { decide, IncidentScope, type CandidateDraft, type MatchInput, type OrderRecord, type PaymentRecord } from "../src/modules/matching/types.ts";
import { adjustment, at, batch, fulfilment, line, order, paidOrder, payment } from "./fixtures.ts";

const NOW = at("2026-10-01");
const recall = (extra: Record<string, unknown> = {}) =>
  IncidentScope.parse({ type: "product", skus: ["CM-412"], batchCodes: ["K-0719"], ...extra });
const match = (input: Partial<MatchInput> & { scope: MatchInput["scope"] }) =>
  runMatch({ now: NOW, orders: [], payments: [], batches: [], ...input });

const affectedLine = () => line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0719" })] });
const undocumentedLine = () => line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: null })] });

/** Ties a payment to an order the way the import does when the payment carries the order number. */
function linkByInvoice(o: OrderRecord, p: PaymentRecord, rivalOrders = 0): void {
  o.paymentLinks.push({ paymentId: p.id, method: "invoice_id", strength: "exact", detail: "the PayPal payment carries the order number as its invoice ID", rivalOrders });
}

// ---------- the table ----------

test("the decision is a fixed table of the two answers, with no score anywhere", () => {
  assert.equal(decide("verified", "proven"), "ready_for_approval");
  assert.equal(decide("verified", "supported"), "needs_eligibility_evidence");
  assert.equal(decide("verified", "uncertain"), "needs_eligibility_evidence");
  assert.equal(decide("verified", "unknown"), "needs_eligibility_evidence");
  assert.equal(decide("ambiguous", "proven"), "reconcile_payment");
  assert.equal(decide("missing", "proven"), "reconcile_payment");
  assert.equal(decide("ambiguous", "uncertain"), "investigate");
  assert.equal(decide("missing", "unknown"), "investigate");
  assert.equal(decide("not_paypal", "proven"), "pay_outside_paypal");
  assert.equal(decide("verified", "not_affected"), "not_affected");
  // Nothing on a candidate is a number between 0 and 1.
  const { order: o, payment: p } = paidOrder({ lines: [affectedLine()] });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  for (const key of Object.keys(c)) assert.doesNotMatch(key, /score|confidence|probab/i);
});

test("quadrant 1: verified payment and proven batch is ready for a person to approve", () => {
  const { order: o, payment: p } = paidOrder({ lines: [affectedLine()] });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.deepEqual([c.paymentIdentity, c.eligibility, c.decision], ["verified", "proven", "ready_for_approval"]);
  assert.equal(c.needsConfirmation, false);
});

test("quadrant 2: verified payment and uncertain batch is held for more evidence", () => {
  const { order: o, payment: p } = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-09-10") })] })] });
  const batches = [
    batch({ batchCode: "K-0719", firstShippedAt: at("2026-09-05"), lastShippedAt: at("2026-09-15") }),
    batch({ batchCode: "K-0726", firstShippedAt: at("2026-09-08"), lastShippedAt: at("2026-09-30") }),
  ];
  const c = match({ scope: recall(), orders: [o], payments: [p], batches }).candidates[0]!;
  assert.deepEqual([c.paymentIdentity, c.eligibility, c.decision], ["verified", "uncertain", "needs_eligibility_evidence"]);
  assert.equal(c.needsConfirmation, true);
  assert.equal(c.status, "proposed");
});

test("quadrant 3: proven batch and ambiguous payment must be reconciled before any refund", () => {
  const o = order({ orderNumber: "#5012", lines: [affectedLine()] });
  const first = payment({ invoiceId: "#5012", grossMinor: o.totalMinor });
  const second = payment({ invoiceId: "#5012", grossMinor: o.totalMinor });
  linkByInvoice(o, first);
  linkByInvoice(o, second);
  const c = match({ scope: recall(), orders: [o], payments: [first, second] }).candidates[0]!;
  assert.deepEqual([c.paymentIdentity, c.eligibility, c.decision], ["ambiguous", "proven", "reconcile_payment"]);
  assert.equal(c.needsConfirmation, true);
  assert.equal(c.recommendedAction, "confirm_payment_link");
  assert.equal(c.facts.rivalPayments?.length, 1, "the other payment is named");
  assert.ok(c.missing.some((m) => /2 PayPal payments/.test(m)));
});

test("quadrant 4: neither settled means manual investigation", () => {
  const o = order({ lines: [undocumentedLine()] });
  const p = payment({ grossMinor: o.totalMinor });
  o.paymentLinks.push({ paymentId: p.id, method: "heuristic", strength: "heuristic", detail: "same email, amount and currency, within ten minutes" });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.deepEqual([c.paymentIdentity, c.eligibility, c.decision], ["ambiguous", "unknown", "investigate"]);
});

// ---------- question 1: payment identity ----------

test("one payment tied to two orders by the same reference is ambiguous for both", () => {
  const a = order({ orderNumber: "#7001", lines: [affectedLine()] });
  const b = order({ orderNumber: "#7001", lines: [affectedLine()] });
  const p = payment({ invoiceId: "#7001", grossMinor: a.totalMinor });
  linkByInvoice(a, p, 1);
  linkByInvoice(b, p, 1);
  const cs = match({ scope: recall(), orders: [a, b], payments: [p] }).candidates;
  assert.deepEqual(cs.map((c) => c.paymentIdentity), ["ambiguous", "ambiguous"]);
  assert.ok(cs.every((c) => c.decision === "reconcile_payment"));
});

test("PayPal's own payment ID on the order beats a shared invoice number", () => {
  const { order: o, payment: real } = paidOrder({ orderNumber: "#8001", lines: [affectedLine()] });
  const stray = payment({ invoiceId: "#8001", grossMinor: o.totalMinor });
  linkByInvoice(o, stray);
  const c = match({ scope: recall(), orders: [o], payments: [real, stray] }).candidates[0]!;
  assert.equal(c.paymentIdentity, "verified");
  assert.equal(c.paymentId, real.id);
  assert.ok(c.reasons.some((r) => /double charge/.test(r)), "the stray payment is pointed out");
});

test("an order paid in parts is verified, and choosing the largest part is marked as our assumption", () => {
  const o = order({ lines: [line({ quantity: 2, fulfilments: [fulfilment({ quantity: 2, batchCode: "K-0719" })] })] });
  const big = payment({ invoiceId: o.orderNumber, grossMinor: 8000 });
  const small = payment({ invoiceId: o.orderNumber, grossMinor: o.totalMinor - 8000 });
  linkByInvoice(o, big);
  linkByInvoice(o, small);
  const c = match({ scope: recall(), orders: [o], payments: [big, small] }).candidates[0]!;
  assert.equal(c.paymentIdentity, "verified");
  assert.equal(c.paymentId, big.id);
  assert.ok(c.evidence.some((e) => e.dimension === "payment" && e.kind === "assumption"));
});

test("a named person's statement settles an ambiguous payment", () => {
  const o = order({ orderNumber: "#5012", lines: [affectedLine()] });
  const first = payment({ invoiceId: "#5012", grossMinor: o.totalMinor });
  const second = payment({ invoiceId: "#5012", grossMinor: o.totalMinor });
  linkByInvoice(o, first);
  o.paymentLinks.push({ paymentId: second.id, method: "manual", strength: "exact", detail: "Olive confirmed it on 2026-09-30: matched the bank reference" });
  const c = match({ scope: recall(), orders: [o], payments: [first, second] }).candidates[0]!;
  assert.equal(c.paymentIdentity, "verified");
  assert.equal(c.paymentId, second.id);
  assert.equal(c.decision, "ready_for_approval");
});

test("a guessed link is an inference, never a fact", () => {
  const o = order({ lines: [affectedLine()] });
  const p = payment({ grossMinor: o.totalMinor });
  o.paymentLinks.push({ paymentId: p.id, method: "heuristic", strength: "heuristic", detail: "same email, amount and currency, within ten minutes" });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  const link = c.evidence.find((e) => e.source === "order_payment_link")!;
  assert.deepEqual([link.dimension, link.kind, link.strength], ["payment", "inference", "weak"]);
});

// ---------- question 2: eligibility ----------

test("PayPal data alone never proves a batch", () => {
  // A payment that names the product, for the right amount, in the right week: still not proof of the batch.
  const named = payment({ items: [{ code: "CM-412", name: "Mug set CM-412 batch K-0719", quantity: 1, unitMinor: 5900 }] });
  const known = paidOrder({ lines: [affectedLine()] });
  const cs = match({ scope: recall(), orders: [known.order], payments: [known.payment, named] }).candidates;
  const loose = cs.find((c) => c.paymentId === named.id)!;
  assert.deepEqual([loose.eligibility, loose.paymentIdentity, loose.decision], ["unknown", "missing", "investigate"]);
  assert.equal(loose.needsConfirmation, true);

  // And the engine checks its own output: "proven" without a packing record or a named person is refused.
  const forged: CandidateDraft = {
    ...loose,
    eligibility: "proven",
    evidence: [{ source: "payment_transaction", recordId: named.id, fact: "names the product", strength: "proves", dimension: "eligibility", kind: "fact" }],
  };
  assert.throws(() => assertUnitProof([forged]), /without a unit-level record/);
  assert.doesNotThrow(() => assertUnitProof(cs));
});

test("each piece of evidence is marked as a fact, an inference or an assumption", () => {
  const scope = recall({ shippedFrom: "2026-09-05T00:00:00Z", shippedTo: "2026-09-15T23:59:59Z" });
  const packed = paidOrder({ lines: [affectedLine()] });
  const inferred = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-08-20"), warehouse: "east" })] })] });
  const assumed = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, shippedAt: at("2026-09-10") })] })] });
  const batches = [batch({ batchCode: "K-0719", warehouse: "east", firstShippedAt: at("2026-08-10"), lastShippedAt: at("2026-08-30") })];
  const cs = match({
    scope,
    orders: [packed.order, inferred.order, assumed.order],
    payments: [packed.payment, inferred.payment, assumed.payment],
    batches,
  }).candidates;
  const kindsFor = (o: OrderRecord) =>
    cs.find((c) => c.orderId === o.id)!.evidence.filter((e) => e.dimension === "eligibility" && e.source !== "order_line").map((e) => e.kind);
  assert.deepEqual(kindsFor(packed.order), ["fact"], "a packing record is a fact");
  assert.ok(kindsFor(inferred.order).includes("inference"), "inventory dates are an inference");
  assert.deepEqual(kindsFor(assumed.order), ["assumption"], "the merchant's ship window is an assumption");
  assert.deepEqual(
    [packed, inferred, assumed].map((x) => cs.find((c) => c.orderId === x.order.id)!.eligibility),
    ["proven", "supported", "uncertain"],
  );
});

test("a replacement makes the unit the customer holds uncertain, even though the first one was proven", () => {
  const { order: o, payment: p } = paidOrder({
    lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0719" })], adjustments: [adjustment({ kind: "replacement", quantity: 1 })] })],
  });
  const c = match({ scope: recall(), orders: [o], payments: [p] }).candidates[0]!;
  assert.equal(c.eligibility, "uncertain");
  assert.equal(c.decision, "needs_eligibility_evidence");
  assert.ok(c.evidence.some((e) => e.source === "order_adjustment" && e.strength === "contradicts"));
});

test("buyers shown not to be affected are kept, with the record that cleared them", () => {
  const other = paidOrder({ lines: [line({ fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0726" })] })] });
  const mixed = paidOrder({
    lines: [line({ quantity: 2, fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0719" }), fulfilment({ quantity: 1, batchCode: "K-0726" })] })],
  });
  const out = match({ scope: recall(), orders: [other.order, mixed.order], payments: [other.payment, mixed.payment] });
  assert.equal(out.candidates.length, 1, "only the affected unit is a candidate");
  assert.equal(out.candidates[0]!.affectedQuantity, 1);
  assert.equal(out.cleared.length, 2);
  for (const c of out.cleared) {
    assert.deepEqual([c.status, c.eligibility, c.decision], ["cleared", "not_affected", "not_affected"]);
    assert.equal(c.facts.clearedBy, "batch_record");
    assert.ok(c.evidence.some((e) => e.kind === "fact" && /not an affected batch/.test(e.fact)));
  }
});

test("payment states are a decision of their own: a dispute holds, a full refund excludes", () => {
  const disputed = paidOrder({ lines: [affectedLine()] }, { disputeState: "open" });
  const refunded = paidOrder({ lines: [affectedLine()] }, { refundedMinor: 5900 });
  const cs = match({ scope: recall(), orders: [disputed.order, refunded.order], payments: [disputed.payment, refunded.payment] }).candidates;
  assert.equal(cs.find((c) => c.orderId === disputed.order.id)!.decision, "on_hold");
  assert.equal(cs.find((c) => c.orderId === refunded.order.id)!.decision, "excluded");
  assert.ok(cs.every((c) => c.status === "excluded" && c.evidence.some((e) => e.dimension === "state")));
});

// ---------- product codes written differently ----------

test("a product code written differently is not matched until a person confirms the alias", () => {
  const messy = paidOrder({ lines: [line({ sku: "CM412", title: "Mug Set 412 W", fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0719" })] })] });
  const noCode = paidOrder({ lines: [line({ sku: null, title: "Mug set CM-412 (white)", fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0719" })] })] });
  const lookalike = paidOrder({ lines: [line({ sku: "CM-4120", title: "Dinner set CM-4120", fulfilments: [fulfilment({ quantity: 1, batchCode: "K-0719" })] })] });
  const input = {
    scope: recall(),
    orders: [messy.order, noCode.order, lookalike.order],
    payments: [messy.payment, noCode.payment, lookalike.payment],
  };
  assert.equal(match(input).candidates.length, 0, "nothing is matched on a guess");

  const withAliases = match({
    ...input,
    aliases: [
      { id: "alias-1", kind: "sku", alias: "cm412", canonicalSku: "CM-412", confirmedBy: "Olive" },
      { id: "alias-2", kind: "title", alias: "Mug Set CM-412 (White)", canonicalSku: "CM-412", confirmedBy: "Olive" },
    ],
  }).candidates;
  assert.equal(withAliases.length, 2, "the look-alike product CM-4120 is still left out");
  for (const c of withAliases) {
    assert.equal(c.decision, "ready_for_approval");
    const alias = c.evidence.find((e) => e.source === "product_alias")!;
    assert.equal(alias.kind, "inference");
    assert.match(alias.fact, /Olive confirmed/);
  }
  assert.equal(withAliases.find((c) => c.orderId === messy.order.id)!.facts.matchedAlias, "cm412");
});
