// Channel3 product catalogue: evidence of what a recalled product is and what a
// new one costs. Tested against a fake catalogue server: no key on this machine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/api/routes.ts";
import { createContainer } from "../src/container.ts";
import { Channel3Catalog, CatalogError, replacementValue, type CatalogOffer } from "../src/modules/catalog/channel3.ts";
import { FakeClock } from "../src/platform/clock.ts";
import { loadConfig } from "../src/platform/config.ts";
import { testDb } from "./helpers.ts";

const offer = (domain: string, price: number, extra: Partial<{ currency: string; availability: string; condition: string }> = {}) => ({
  url: `https://buy.trychannel3.com/x?aid=tracking-${domain}`,
  domain,
  price: { price, compare_at_price: null, currency: extra.currency ?? "USD" },
  availability: extra.availability ?? "InStock",
  condition: extra.condition ?? "new",
});
const MIXER = {
  id: "prod_mixer",
  title: "Ceramic Mug 12 oz",
  brands: [{ id: "b1", name: "Emberline" }],
  images: [{ url: "https://img.example/mug.jpg" }],
  offers: [
    offer("shop-a.com", 24),
    offer("shop-b.com", 19.5),
    offer("shop-c.com", 29.99),
    offer("shop-d.com", 21, { availability: "OutOfStock" }),
    offer("shop-e.com", 9, { condition: "used" }),
    offer("shop-f.co.uk", 18, { currency: "GBP" }),
    offer("shop-g.com", 12.345), // more decimals than USD has: left out, not rounded
  ],
};

/** A fake Channel3 that records every request it receives. */
function fakeChannel3(opts: { status?: number; retryAfter?: string } = {}) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: (init?.body as string) ?? null });
    if (opts.status) return new Response("{}", { status: opts.status, headers: opts.retryAfter ? { "retry-after": opts.retryAfter } : {} });
    if (url.endsWith("/v1/search")) return Response.json({ products: [MIXER, { id: "prod_other", title: "Stoneware Mug", brands: [], offers: [] }, { title: "no id" }], next_page_token: null });
    if (url.includes("/v1/products/prod_mixer")) return Response.json(MIXER);
    return new Response("{}", { status: 404 });
  };
  return { calls, fetchImpl };
}

test("replacement value: new and in stock first, the lower middle price, one currency", () => {
  const offers: CatalogOffer[] = [
    { domain: "a.com", priceMinor: 2400, currency: "USD", availability: "InStock", condition: "new" },
    { domain: "b.com", priceMinor: 1950, currency: "USD", availability: "InStock", condition: "new" },
    { domain: "c.com", priceMinor: 2999, currency: "USD", availability: "InStock", condition: "new" },
    { domain: "d.com", priceMinor: 2100, currency: "USD", availability: "OutOfStock", condition: "new" },
    { domain: "e.com", priceMinor: 900, currency: "USD", availability: "InStock", condition: "used" },
    { domain: "f.co.uk", priceMinor: 1800, currency: "GBP", availability: "InStock", condition: "new" },
  ];
  assert.deepEqual(replacementValue(offers), { currency: "USD", basis: "new_in_stock", offers: 3, retailers: 3, medianMinor: 2400, minMinor: 1950, maxMinor: 2999 });
  assert.equal(replacementValue([...offers.slice(0, 2)])!.medianMinor, 1950, "an even count takes the lower middle: a price a retailer actually asked");
  assert.deepEqual(replacementValue([offers[3]!]), { currency: "USD", basis: "new_any", offers: 1, retailers: 1, medianMinor: 2100, minMinor: 2100, maxMinor: 2100 }, "nothing in stock: every new offer");
  assert.equal(replacementValue([offers[4]!]), null, "used offers alone give no replacement value");
  assert.equal(replacementValue([]), null);
});

test("the Channel3 client sends only the query, with the key in a header, and keeps no buy links", async () => {
  const fake = fakeChannel3();
  const catalog = new Channel3Catalog({ apiKey: "test-key", fetchImpl: fake.fetchImpl });
  const found = await catalog.search("ceramic mug 12 oz", 5);
  assert.equal(fake.calls[0]!.method, "POST");
  assert.equal(fake.calls[0]!.url, "https://api.trychannel3.com/v1/search");
  assert.equal(fake.calls[0]!.headers["x-api-key"], "test-key");
  assert.deepEqual(JSON.parse(fake.calls[0]!.body!), { query: "ceramic mug 12 oz", limit: 5 }, "nothing but the words and a limit");
  assert.deepEqual(found.map((p) => p.id), ["prod_mixer", "prod_other"], "a product with no ID is dropped");
  const mug = found[0]!;
  assert.equal(mug.brand, "Emberline");
  assert.equal(mug.offers.length, 6, "the offer with too many decimals is left out");
  assert.ok(!JSON.stringify(mug).includes("buy.trychannel3.com"), "affiliate buy links are not kept");
  assert.deepEqual(mug.offers[1], { domain: "shop-b.com", priceMinor: 1950, currency: "USD", availability: "InStock", condition: "new" });

  await assert.rejects(new Channel3Catalog({ apiKey: "k", fetchImpl: fakeChannel3({ status: 429, retryAfter: "7" }).fetchImpl }).search("mug"), (e: unknown) => {
    assert.ok(e instanceof CatalogError);
    assert.equal(e.httpStatus, 429);
    assert.deepEqual(e.details, { retryAfterSeconds: 7 });
    return true;
  });
  await assert.rejects(new Channel3Catalog({ apiKey: "bad", fetchImpl: fakeChannel3({ status: 403 }).fetchImpl }).search("mug"), /refused the API key/);
  const down: typeof fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(new Channel3Catalog({ apiKey: "k", fetchImpl: down }).product("x"), (e: unknown) => e instanceof CatalogError && e.httpStatus === 504);
});

async function harness(withCatalog: boolean) {
  const db = await testDb();
  const clock = new FakeClock("2026-11-12T09:00:00.000Z");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:4000" }, { readEnvFiles: false });
  const fake = fakeChannel3();
  const catalog = withCatalog ? new Channel3Catalog({ apiKey: "test-key", fetchImpl: fake.fetchImpl }) : null;
  const container = await createContainer(config, { db, clock, passwordCost: { N: 1024, r: 8, p: 1 }, ai: null, catalog });
  const { app } = buildApp(container);
  await app.ready();
  let cookie = "";
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await app.inject({
      method, url, payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-make-good": "1" }), ...(cookie ? { cookie } : {}) },
    });
    const set = res.headers["set-cookie"];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const ok = async (p: Promise<{ status: number; body: any }>) => {
    const r = await p;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  await ok(call("POST", "/api/auth/register", { email: "ada@example.com", password: "correct horse battery", name: "Ada" }));
  const org: string = (await ok(call("POST", "/api/orgs", { name: "Emberline Ceramics" }))).id;
  await ok(call("POST", `/api/orgs/${org}/paypal/simulator`));
  const seeded = await ok(call("POST", `/api/orgs/${org}/demo/recall-scenario`));
  return { db, fake, call, ok, org, inc: `/api/orgs/${org}/incidents/${seeded.incidentId}` };
}

test("without a key the catalogue says it is off, and nothing is sent anywhere", async () => {
  const h = await harness(false);
  const list = await h.ok(h.call("GET", `${h.inc}/catalog`));
  assert.equal(list.configured, false);
  assert.deepEqual(list.references, []);
  const search = await h.call("POST", `${h.inc}/catalog/search`, { query: "ceramic mug" });
  assert.equal(search.status, 503);
  assert.equal(search.body.error.code, "CATALOG_NOT_CONFIGURED");
  assert.equal(h.fake.calls.length, 0);
});

test("search saves nothing; a person's confirmation saves one dated row and an audit entry", async () => {
  const h = await harness(true);
  const rows = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from catalog_references"))[0]!.n;
  const audits = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from audit_events where action = 'evidence.catalog_product_confirmed'"))[0]!.n;

  const found = await h.ok(h.call("POST", `${h.inc}/catalog/search`, { query: "Emberline ceramic mug 12 oz" }));
  assert.equal(found.products[0].id, "prod_mixer");
  assert.deepEqual(found.products[0].replacementValue, { currency: "USD", basis: "new_in_stock", offers: 3, retailers: 3, medianMinor: 2400, minMinor: 1950, maxMinor: 2999 });
  assert.equal(await rows(), 0, "a search saves nothing");

  const customers = await h.db.query<{ customer_email: string | null }>("select customer_email from orders where customer_email is not null limit 5");
  for (const c of h.fake.calls) for (const { customer_email } of customers) assert.ok(!(c.body ?? "").includes(customer_email!), "no customer data leaves for the catalogue");

  assert.equal((await h.call("POST", `${h.inc}/catalog/confirm`, { query: "x" })).status, 422, "a product ID is required");
  const missing = await h.call("POST", `/api/orgs/${h.org}/incidents/00000000-0000-4000-8000-000000000000/catalog/confirm`, { query: "mug", productId: "prod_mixer" });
  assert.equal(missing.status, 404);

  const saved = await h.ok(h.call("POST", `${h.inc}/catalog/confirm`, { query: "Emberline ceramic mug 12 oz", productId: "prod_mixer" }));
  assert.equal(saved.retrievedAt, "2026-11-12T09:00:00.000Z");
  assert.equal(await rows(), 1);
  assert.equal(await audits(), 1, "who confirmed it is on the audit trail");

  const list = await h.ok(h.call("GET", `${h.inc}/catalog`));
  assert.equal(list.configured, true);
  const ref = list.references[0];
  assert.deepEqual(
    [ref.title, ref.brand, ref.currency, ref.median_minor, ref.min_minor, ref.max_minor, ref.offer_count, ref.retailer_count, ref.basis, ref.confirmed_by_name],
    ["Ceramic Mug 12 oz", "Emberline", "USD", 2400, 1950, 2999, 3, 3, "new_in_stock", "Ada"],
  );
  assert.ok(!JSON.stringify(ref.offers).includes("buy.trychannel3.com"), "the stored offers carry no buy links");

  await assert.rejects(h.db.query("update catalog_references set median_minor = 1"), /never changed/, "a saved reference cannot be edited");
});
