import assert from "node:assert/strict";
import { test } from "node:test";
import { ordersFromCsv, parseCsv } from "../src/modules/commerce/csv.ts";

const HEAD = "order_number,placed_at,currency,customer_email,customer_name,paypal_payment_id,sku,title,quantity,unit_price,order_discount,shipping,shipped_at,batch_code";

test("CSV parsing handles quotes, commas and line breaks inside a field", () => {
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\n"two\nlines",z\n\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'he said "hi"'], ["two\nlines", "z"]]);
});

test("rows with one order number become one order, and the total is worked out when absent", () => {
  const csv = [
    HEAD,
    '#9001,2026-10-01,usd,pat@example.com,"Rao, Pat",8AB12345CD678901E,HM-300,Hand mixer HM-300,1,59.00,9.80,6.00,2026-10-02,B-2217',
    "#9001,2026-10-01,usd,pat@example.com,,,KT-120,Kettle KT-120,1,39.00,,,2026-10-02,",
    "#9002,2026-10-03T09:30:00Z,USD,sam@example.com,Sam,,HM-300,Hand mixer HM-300,2,59.00,,,,",
  ].join("\n");
  const { orders, errors, rows } = ordersFromCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(rows, 3);
  const [a, b] = orders as [typeof orders[number], typeof orders[number]];
  assert.deepEqual([a.orderNumber, a.currency, a.customer.name, a.paymentMethod, a.paymentReference, a.total], ["#9001", "USD", "Rao, Pat", "paypal", "8AB12345CD678901E", "94.20"]);
  assert.equal(a.lines.length, 2);
  assert.deepEqual(a.fulfilments[0]!.lines.map((l) => l.batchCode), ["B-2217", null], "an empty batch code stays empty");
  assert.deepEqual([b.paymentMethod, b.total, b.fulfilments.length], ["unknown", "118.00", 0], "no shipping data means no shipping record");
});

test("unreadable rows are reported by row number and do not stop the others", () => {
  const csv = [
    HEAD,
    "#9001,not a date,USD,a@example.com,A,,HM-300,Mixer,1,59.00,,,,",
    "#9002,2026-10-01,USD,b@example.com,B,,HM-300,Mixer,one,59.00,,,,",
    "#9003,2026-10-01,JPY,c@example.com,C,,HM-300,Mixer,1,59.50,,,,",
    ",2026-10-01,USD,d@example.com,D,,HM-300,Mixer,1,59.00,,,,",
    "#9005,2026-10-01,USD,e@example.com,E,,HM-300,Mixer,1,59.00,,,,",
  ].join("\n");
  const { orders, errors } = ordersFromCsv(csv);
  assert.deepEqual(orders.map((o) => o.orderNumber), ["#9005"]);
  assert.deepEqual(errors.map((e) => e.row).sort(), [2, 3, 4, 5]);
  assert.match(errors.find((e) => e.row === 3)!.message, /quantity "one"/);
});

test("a file without the needed columns is refused with the column names", () => {
  const { orders, errors } = ordersFromCsv("order_number,sku\n#1,HM-300\n");
  assert.equal(orders.length, 0);
  assert.deepEqual(errors.map((e) => e.message), ["placed_at", "currency", "title", "quantity", "unit_price"].map((c) => `The column "${c}" is missing.`));
});
