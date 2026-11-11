// Small builders for the records the engines work on, so each test states
// only what matters to it.

import type {
  AdjustmentRecord,
  FulfilmentLineRecord,
  InventoryBatchRecord,
  OrderLineRecord,
  OrderRecord,
  PaymentRecord,
} from "../src/modules/matching/types.ts";

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;
export const at = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);

export function fulfilment(input: Partial<FulfilmentLineRecord> & { quantity: number }): FulfilmentLineRecord {
  return {
    id: id("ful"),
    fulfilmentId: id("shp"),
    shippedAt: at("2026-09-10"),
    warehouse: "default",
    batchCode: null,
    serials: [],
    ...input,
  };
}

export function adjustment(input: Partial<AdjustmentRecord> & { kind: AdjustmentRecord["kind"] }): AdjustmentRecord {
  return { id: id("adj"), quantity: 0, amountMinor: 0, occurredAt: at("2026-09-20"), ...input };
}

export function line(input: Partial<OrderLineRecord> = {}): OrderLineRecord {
  return {
    id: id("line"),
    sku: "HM-300",
    variantId: null,
    title: "Hand mixer HM-300",
    kind: "physical",
    quantity: 1,
    unitPriceMinor: 5900,
    discountMinor: 0,
    taxMinor: 0,
    parentLineId: null,
    serviceStart: null,
    serviceEnd: null,
    fulfilments: [],
    adjustments: [],
    ...input,
  };
}

export function order(input: Partial<OrderRecord> & { lines: OrderLineRecord[] }): OrderRecord {
  const subtotal = input.lines.reduce((a, l) => a + l.unitPriceMinor * l.quantity, 0);
  const lineDiscounts = input.lines.reduce((a, l) => a + l.discountMinor, 0);
  const discount = input.discountMinor ?? lineDiscounts;
  const shipping = input.shippingMinor ?? 0;
  const tax = input.taxMinor ?? input.lines.reduce((a, l) => a + l.taxMinor, 0);
  const orderId = input.id ?? id("ord");
  return {
    id: orderId,
    orderNumber: input.orderNumber ?? `#${1000 + seq}`,
    channel: "online",
    placedAt: at("2026-09-08"),
    currency: "USD",
    customerEmail: "pat@example.com",
    customerName: "Pat Customer",
    isGuest: false,
    paymentMethod: "paypal",
    subtotalMinor: subtotal,
    discountMinor: discount,
    shippingMinor: shipping,
    taxMinor: tax,
    totalMinor: subtotal - discount + shipping + tax,
    status: "paid",
    adjustments: [],
    paymentLinks: [],
    ...input,
  };
}

export function payment(input: Partial<PaymentRecord> = {}): PaymentRecord {
  const n = ++seq;
  return {
    id: `pay-${n}`,
    transactionId: `CAP${String(n).padStart(14, "0")}`,
    occurredAt: at("2026-09-08"),
    currency: "USD",
    grossMinor: 5900,
    refundedMinor: 0,
    payerId: `PAYER${n}`,
    payerEmail: "pat@example.com",
    payerName: "Pat Customer",
    payerCountry: "US",
    invoiceId: null,
    customId: null,
    items: [],
    disputeState: null,
    ...input,
  };
}

/** An order paid by a PayPal payment, linked exactly (the store recorded the payment ID). */
export function paidOrder(
  input: Partial<OrderRecord> & { lines: OrderLineRecord[] },
  pay: Partial<PaymentRecord> = {},
): { order: OrderRecord; payment: PaymentRecord } {
  const o = order(input);
  const p = payment({ grossMinor: o.totalMinor, currency: o.currency, occurredAt: o.placedAt, invoiceId: o.orderNumber, ...pay });
  o.paymentLinks.push({ paymentId: p.id, method: "store_reference", strength: "exact", detail: "the store recorded this payment ID on the order" });
  return { order: o, payment: p };
}

export function batch(input: Partial<InventoryBatchRecord> & { batchCode: string }): InventoryBatchRecord {
  return {
    id: id("bat"),
    variantId: "var-hm300",
    sku: "HM-300",
    warehouse: "default",
    receivedAt: null,
    firstShippedAt: null,
    lastShippedAt: null,
    ...input,
  };
}
