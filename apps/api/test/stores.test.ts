// Shopify and WooCommerce connectors, against recorded response shapes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectStore, publicStoreUrl, syncStore } from "../src/modules/commerce/stores.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { generateEncryptionKey, SecretBox } from "../src/platform/crypto.ts";
import { testDb } from "./helpers.ts";

const money = (amount: string) => ({ shopMoney: { amount } });
const shopifyOrder = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: "2026-10-01T10:00:00Z", currencyCode: "USD", email: `buyer${n}@example.com`, cancelledAt: null,
  displayFinancialStatus: "PAID", paymentGatewayNames: ["paypal"], customer: { id: `gid://shopify/Customer/${n}`, displayName: `Buyer ${n}` },
  shippingAddress: { countryCodeV2: "US", name: `Buyer ${n}` },
  totalPriceSet: money("64.00"), totalDiscountsSet: money("0.00"), totalShippingPriceSet: money("5.00"), totalTaxSet: money("0.00"),
  lineItems: { nodes: [{ id: `gid://shopify/LineItem/${n}`, sku: "HM-300", title: "Hand mixer", quantity: 1, originalUnitPriceSet: money("59.00"), totalDiscountSet: money("0.00") }] },
  transactions: [{ gateway: "paypal", kind: "SALE", status: "SUCCESS", authorizationCode: `PAYPAL-${n}` }],
  ...extra,
});

async function setup() {
  const db = await testDb();
  const clock = new FakeClock("2026-11-12T09:00:00.000Z");
  const secrets = new SecretBox({ k1: generateEncryptionKey() }, "k1");
  const [org] = await db.query<{ id: string }>("insert into organisations (name, slug) values ('Kitchen Co', 'kitchen-co') returning id");
  const calls: { url: string; init: RequestInit }[] = [];
  let reply: (url: string, init: RequestInit) => Response = () => new Response("{}", { status: 500 });
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return reply(String(url), init!);
  };
  return { db, clock, secrets, orgId: org!.id, calls, fetchImpl, setReply: (r: typeof reply) => (reply = r) };
}

test("Shopify: connects with a working token only, reads every page, imports orders with their PayPal reference", async () => {
  const s = await setup();
  const deps = { db: s.db, clock: s.clock, secrets: s.secrets, fetchImpl: s.fetchImpl };
  s.setReply(() => new Response(JSON.stringify({ errors: [{ message: "Invalid API key or access token" }] }), { status: 401 }));
  await assert.rejects(
    connectStore(deps, { orgId: s.orgId, kind: "shopify", data: { name: "Main", shopDomain: "kitchen-co.myshopify.com", accessToken: "shpat_wrong_token" } }),
    /refused the access token/,
  );
  assert.equal((await s.db.query("select 1 from commerce_connections")).length, 0, "nothing is saved for a token that does not work");

  s.setReply((_url, init) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: { cursor: string | null } };
    const page = variables.cursor === null ? 1 : 2;
    const nodes =
      page === 1 ? [shopifyOrder(1001), shopifyOrder(1002, { cancelledAt: "2026-10-02T00:00:00Z" })] : [shopifyOrder(1003, { displayFinancialStatus: "PARTIALLY_REFUNDED" })];
    return new Response(JSON.stringify({ data: { orders: { pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "c1" : null }, nodes } } }), { status: 200 });
  });
  const { id } = await connectStore(deps, { orgId: s.orgId, kind: "shopify", data: { name: "Main", shopDomain: "kitchen-co.myshopify.com", accessToken: "shpat_good_token" } });
  const [row] = await s.db.query<{ credentials_ciphertext: string; base_url: string }>("select credentials_ciphertext, base_url from commerce_connections where id = $1", [id]);
  assert.equal(row!.base_url, "https://kitchen-co.myshopify.com");
  assert.equal(row!.credentials_ciphertext.includes("shpat_good_token"), false, "the token is stored encrypted");
  const headers = s.calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(headers["X-Shopify-Access-Token"], "shpat_good_token");
  assert.match(s.calls.at(-1)!.url, /^https:\/\/kitchen-co\.myshopify\.com\/admin\/api\/[\d-]+\/graphql\.json$/);

  s.calls.length = 0;
  const out = await syncStore(deps, { orgId: s.orgId, storeId: id });
  assert.deepEqual([out.read, out.created, out.skipped.length, out.complete], [3, 3, 0, true]);
  assert.equal(s.calls.length, 2, "both pages were read");
  assert.match(JSON.parse(String(s.calls[0]!.init.body)).variables.query, /^updated_at:>='2025-11-12/, "the first sync reads a year back");
  const orders = await s.db.query<{ order_number: string; status: string; payment_method: string; payment_reference: string; customer_email: string; total_minor: number }>(
    "select order_number, status, payment_method, payment_reference, customer_email, total_minor from orders order by order_number",
  );
  assert.deepEqual(
    orders.map((o) => [o.order_number, o.status, o.payment_method, o.payment_reference, o.total_minor]),
    [
      ["1001", "paid", "paypal", "PAYPAL-1001", 6400],
      ["1002", "cancelled", "paypal", "PAYPAL-1002", 6400],
      ["1003", "partially_refunded", "paypal", "PAYPAL-1003", 6400],
    ],
  );
  assert.equal(orders[0]!.customer_email, "buyer1001@example.com");

  const again = await syncStore(deps, { orgId: s.orgId, storeId: id });
  assert.deepEqual([again.created, again.updated], [0, 3], "a second sync updates, never duplicates");
  assert.match(JSON.parse(String(s.calls.at(-1)!.init.body)).variables.query, /2026-11-12T08:50/, "and starts from the last sync, with a little overlap");
});

test("WooCommerce: refuses private addresses, reads pages, maps the PayPal transaction ID", async () => {
  for (const bad of ["http://shop.example.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.5", "https://192.168.1.2", "https://[::1]"]) {
    assert.throws(() => publicStoreUrl(bad), /https|public/, bad);
  }
  const s = await setup();
  const deps = { db: s.db, clock: s.clock, secrets: s.secrets, fetchImpl: s.fetchImpl };
  const woo = (id: number) => ({
    id, number: String(id), date_created_gmt: "2026-10-03T12:00:00", currency: "EUR", status: "completed", customer_id: 0,
    billing: { email: `w${id}@example.com`, first_name: "Wren", last_name: `No${id}` }, shipping: { first_name: "Wren", last_name: `No${id}`, country: "DE" },
    payment_method: "ppcp-gateway", payment_method_title: "PayPal", transaction_id: `CAP-${id}`,
    discount_total: "5.00", shipping_total: "4.00", total_tax: "0.00", total: "49.00",
    line_items: [{ id: id * 10, sku: "HM-300", name: "Hand mixer", quantity: 2, subtotal: "50.00", total: "45.00", total_tax: "0.00" }],
  });
  s.setReply((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(page === 1 ? [woo(1), woo(2)] : [woo(3)]), { status: 200, headers: { "x-wp-totalpages": "2" } });
  });
  const { id } = await connectStore(deps, {
    orgId: s.orgId, kind: "woocommerce", data: { name: "Woo", baseUrl: "https://shop.example.com/", consumerKey: "ck_abc123", consumerSecret: "cs_def456" },
  });
  assert.match(String((s.calls[0]!.init.headers as Record<string, string>).Authorization), /^Basic /);
  const out = await syncStore(deps, { orgId: s.orgId, storeId: id });
  assert.deepEqual([out.read, out.created], [3, 3]);
  const [o] = await s.db.query<{ payment_reference: string; currency: string; total_minor: number; customer_name: string }>(
    "select payment_reference, trim(currency) as currency, total_minor, customer_name from orders where order_number = '1'",
  );
  assert.deepEqual([o!.payment_reference, o!.currency, o!.total_minor, o!.customer_name], ["CAP-1", "EUR", 4900, "Wren No1"]);
  const [line] = await s.db.query<{ unit_price_minor: number; discount_minor: number; quantity: number }>(
    "select unit_price_minor, discount_minor, quantity from order_lines where external_id = '10'",
  );
  assert.deepEqual([line!.unit_price_minor, line!.discount_minor, line!.quantity], [2500, 500, 2], "line price and discount survive exactly");

  s.setReply(() => new Response("{}", { status: 401 }));
  await assert.rejects(syncStore(deps, { orgId: s.orgId, storeId: id }), /refused the API keys/);
  const [st] = await s.db.query<{ status: string; last_error: string }>("select status, last_error from commerce_connections where id = $1", [id]);
  assert.equal(st!.status, "invalid", "a refused key marks the store, so the screen can say so");
});
