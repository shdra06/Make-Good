// Store connectors: Shopify (GraphQL Admin API) and WooCommerce (REST API v3).
//
// The shop connects with credentials it creates in its own store admin:
//   Shopify:      a custom app's Admin API access token, with the read_orders scope
//                 (read_all_orders to reach orders older than 60 days).
//   WooCommerce:  a REST API key pair with Read permission.
// Credentials are encrypted at rest. A sync reads orders changed since the last
// sync (the first one: the last 365 days) and imports them like any other
// orders, then links them to PayPal payments.
//
// Not yet run against a real Shopify store or WooCommerce site: tested against
// recorded response shapes only. See docs/PRODUCTION-GAPS.md.

import { z } from "zod";
import { DAY } from "../../platform/clock.ts";
import type { Clock } from "../../platform/clock.ts";
import type { SecretBox } from "../../platform/crypto.ts";
import type { Db } from "../../platform/db/db.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import { linkOrdersToPayments } from "../transactions/sync.ts";
import { OrderImport, upsertOrder } from "./ingest.ts";

type Deps = { db: Db; clock: Clock; secrets: SecretBox; fetchImpl?: typeof fetch };

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2025-10";
const MAX_PAGES = 40;

export const ShopifyCredentials = z.object({
  name: z.string().trim().min(2).max(120),
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .refine((s) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s), "Use the store's myshopify.com address, such as kitchen-co.myshopify.com."),
  accessToken: z.string().trim().min(10).max(200),
});

export const WooCredentials = z.object({
  name: z.string().trim().min(2).max(120),
  baseUrl: z.string().trim().url(),
  consumerKey: z.string().trim().regex(/^ck_[A-Za-z0-9]+$/, "The consumer key starts with ck_."),
  consumerSecret: z.string().trim().regex(/^cs_[A-Za-z0-9]+$/, "The consumer secret starts with cs_."),
});

/** The store's address must be a public https site: the server will call it. */
export function publicStoreUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new ValidationError("The store address must start with https://.");
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.startsWith("[") || /^\d+$/.test(host);
  if (privateHost) throw new ValidationError("The store address must be a public website.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

type Creds = { kind: "shopify"; shopDomain: string; accessToken: string } | { kind: "woocommerce"; baseUrl: string; consumerKey: string; consumerSecret: string };

async function http(deps: Deps, url: string, init: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ConflictError("STORE_UNREACHABLE", `The store did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body, headers: res.headers };
}

// ---------- Shopify ----------

const ORDERS_QUERY = `query Orders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt currencyCode email cancelledAt displayFinancialStatus paymentGatewayNames
      customer { id displayName }
      shippingAddress { countryCodeV2 name }
      totalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      lineItems(first: 100) { nodes { id sku title quantity originalUnitPriceSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } } } }
      transactions(first: 10) { gateway kind status authorizationCode }
    }
  }
}`;

type Money = { shopMoney: { amount: string } } | null;
type ShopifyOrder = {
  id: string; name: string; createdAt: string; currencyCode: string; email: string | null; cancelledAt: string | null; displayFinancialStatus: string | null;
  paymentGatewayNames: string[]; customer: { id: string; displayName: string } | null; shippingAddress: { countryCodeV2: string | null; name: string | null } | null;
  totalPriceSet: Money; totalDiscountsSet: Money; totalShippingPriceSet: Money; totalTaxSet: Money;
  lineItems: { nodes: { id: string; sku: string | null; title: string; quantity: number; originalUnitPriceSet: Money; totalDiscountSet: Money }[] };
  transactions: { gateway: string | null; kind: string; status: string; authorizationCode: string | null }[];
};
const amount = (m: Money) => m?.shopMoney.amount ?? "0";
const isPayPal = (s: string | null | undefined) => Boolean(s && /paypal|ppcp/i.test(s));

export function mapShopifyOrder(o: ShopifyOrder) {
  const paypal = o.paymentGatewayNames.some(isPayPal);
  const capture = o.transactions.find((t) => isPayPal(t.gateway) && ["SALE", "CAPTURE"].includes(t.kind) && t.status === "SUCCESS");
  const fin = (o.displayFinancialStatus ?? "").toUpperCase();
  return OrderImport.parse({
    externalId: o.id,
    orderNumber: o.name.replace(/^#/, ""),
    placedAt: o.createdAt,
    currency: o.currencyCode,
    customer: { email: o.email, name: o.customer?.displayName ?? o.shippingAddress?.name ?? null, externalId: o.customer?.id ?? null, isGuest: !o.customer },
    shippingName: o.shippingAddress?.name ?? null,
    shippingCountry: o.shippingAddress?.countryCodeV2 ?? null,
    paymentMethod: paypal ? "paypal" : o.paymentGatewayNames.length ? "other" : "unknown",
    paymentReference: capture?.authorizationCode ?? null,
    discount: "0", // Shopify's line discounts already include order-level discounts allocated to lines
    shipping: amount(o.totalShippingPriceSet),
    tax: amount(o.totalTaxSet),
    total: amount(o.totalPriceSet),
    status: o.cancelledAt ? "cancelled" : fin === "REFUNDED" ? "refunded" : fin === "PARTIALLY_REFUNDED" ? "partially_refunded" : fin === "PAID" ? "paid" : "pending",
    lines: o.lineItems.nodes.map((l) => ({
      externalId: l.id, sku: l.sku || null, title: l.title, quantity: l.quantity, unitPrice: amount(l.originalUnitPriceSet), discount: amount(l.totalDiscountSet),
    })),
    raw: { source: "shopify", id: o.id },
  });
}

async function shopifyPage(deps: Deps, creds: Extract<Creds, { kind: "shopify" }>, variables: Record<string, unknown>) {
  const res = await http(deps, `https://${creds.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": creds.accessToken },
    body: JSON.stringify({ query: ORDERS_QUERY, variables }),
  });
  if (res.status === 401 || res.status === 403) throw new ConflictError("STORE_REFUSED", "Shopify refused the access token. Check it, and that the app has the read_orders scope.");
  const body = res.body as { data?: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrder[] } }; errors?: { message: string }[] };
  if (res.status !== 200 || !body?.data) {
    throw new ConflictError("STORE_ERROR", `Shopify answered ${res.status}: ${body?.errors?.map((e) => e.message).join("; ") ?? "no orders in the reply"}`);
  }
  return body.data.orders;
}

// ---------- WooCommerce ----------

type WooOrder = {
  id: number; number: string; date_created_gmt: string; currency: string; status: string; customer_id: number;
  billing: { email?: string; first_name?: string; last_name?: string }; shipping: { first_name?: string; last_name?: string; country?: string };
  payment_method: string; payment_method_title?: string; transaction_id: string;
  discount_total: string; shipping_total: string; total_tax: string; total: string;
  line_items: { id: number; sku: string; name: string; quantity: number; subtotal: string; total: string; total_tax: string }[];
};

export function mapWooOrder(o: WooOrder) {
  const paypal = isPayPal(o.payment_method) || isPayPal(o.payment_method_title);
  const name = [o.billing.first_name, o.billing.last_name].filter(Boolean).join(" ") || null;
  const shipName = [o.shipping.first_name, o.shipping.last_name].filter(Boolean).join(" ") || null;
  const status = { completed: "paid", processing: "paid", refunded: "refunded", cancelled: "cancelled", failed: "cancelled" }[o.status] ?? "pending";
  const cents = (s: string) => Math.round(Number(s) * 100);
  return OrderImport.parse({
    externalId: String(o.id),
    orderNumber: o.number || String(o.id),
    placedAt: o.date_created_gmt.endsWith("Z") ? o.date_created_gmt : `${o.date_created_gmt}Z`,
    currency: o.currency,
    customer: { email: o.billing.email || null, name, externalId: o.customer_id ? String(o.customer_id) : null, isGuest: !o.customer_id },
    billingEmail: o.billing.email || null,
    shippingName: shipName,
    shippingCountry: o.shipping.country && /^[A-Z]{2}$/.test(o.shipping.country) ? o.shipping.country : null,
    paymentMethod: paypal ? "paypal" : o.payment_method ? "other" : "unknown",
    paymentReference: paypal && o.transaction_id ? o.transaction_id : null,
    discount: "0", // line totals already carry the discount
    shipping: o.shipping_total,
    tax: o.total_tax,
    total: o.total,
    status,
    lines: o.line_items.map((l) => ({
      externalId: String(l.id), sku: l.sku || null, title: l.name, quantity: l.quantity,
      unitPrice: ((cents(l.subtotal) / l.quantity) / 100).toFixed(2), discount: ((cents(l.subtotal) - cents(l.total)) / 100).toFixed(2),
    })),
    raw: { source: "woocommerce", id: o.id },
  });
}

async function wooPage(deps: Deps, creds: Extract<Creds, { kind: "woocommerce" }>, page: number, since: Date | null) {
  const url = new URL(`${creds.baseUrl}/wp-json/wc/v3/orders`);
  url.searchParams.set("per_page", "50");
  url.searchParams.set("page", String(page));
  url.searchParams.set("orderby", "modified");
  url.searchParams.set("order", "asc");
  if (since) url.searchParams.set("modified_after", since.toISOString().replace(/\.\d+Z$/, ""));
  const res = await http(deps, url.toString(), {
    headers: { Authorization: `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64")}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new ConflictError("STORE_REFUSED", "WooCommerce refused the API keys. Check them, and that they have Read permission.");
  if (res.status === 404) throw new ConflictError("STORE_ERROR", "No WooCommerce REST API at that address. Check the site address, and that permalinks are on.");
  if (res.status !== 200 || !Array.isArray(res.body)) throw new ConflictError("STORE_ERROR", `WooCommerce answered ${res.status}.`);
  return { orders: res.body as WooOrder[], pages: Number(res.headers.get("x-wp-totalpages") ?? "1") || 1 };
}

// ---------- connect and sync ----------

export async function connectStore(
  deps: Deps,
  input: { orgId: string } & ({ kind: "shopify"; data: z.infer<typeof ShopifyCredentials> } | { kind: "woocommerce"; data: z.infer<typeof WooCredentials> }),
): Promise<{ id: string }> {
  let creds: Creds;
  let baseUrl: string;
  if (input.kind === "shopify") {
    creds = { kind: "shopify", shopDomain: input.data.shopDomain, accessToken: input.data.accessToken };
    baseUrl = `https://${input.data.shopDomain}`;
    await shopifyPage(deps, creds, { cursor: null, query: null }); // proves the token works before anything is saved
  } else {
    baseUrl = publicStoreUrl(input.data.baseUrl).toString().replace(/\/$/, "");
    creds = { kind: "woocommerce", baseUrl, consumerKey: input.data.consumerKey, consumerSecret: input.data.consumerSecret };
    await wooPage(deps, creds, 1, null);
  }
  const rows = await deps.db.query<{ id: string }>(
    `insert into commerce_connections (org_id, kind, name, base_url, credentials_ciphertext, status)
     values ($1, $2, $3, $4, $5, 'connected')
     on conflict (org_id, name) do nothing returning id`,
    [input.orgId, input.kind, input.data.name, baseUrl, deps.secrets.encrypt(JSON.stringify(creds))],
  );
  if (!rows[0]) throw new ConflictError("STORE_NAME_TAKEN", "A store with this name is already connected. Choose another name.");
  return { id: rows[0].id };
}

export async function syncStore(deps: Deps, input: { orgId: string; storeId: string }) {
  const [store] = await deps.db.query<{ kind: string; credentials_ciphertext: string | null; last_synced_at: Date | null }>(
    "select kind, credentials_ciphertext, last_synced_at from commerce_connections where org_id = $1 and id = $2",
    [input.orgId, input.storeId],
  );
  if (!store) throw new NotFoundError("Store");
  if (!store.credentials_ciphertext || (store.kind !== "shopify" && store.kind !== "woocommerce")) {
    throw new ValidationError("This store is not connected to Shopify or WooCommerce. Import its orders as CSV.");
  }
  const creds = JSON.parse(deps.secrets.decrypt(store.credentials_ciphertext)) as Creds;
  const startedAt = deps.clock.now();
  // A little overlap, so an order changed during the last sync is read again (importing is idempotent).
  const since = store.last_synced_at ? new Date(new Date(store.last_synced_at).getTime() - 10 * 60_000) : new Date(startedAt.getTime() - 365 * DAY);
  const out = { read: 0, created: 0, updated: 0, skipped: [] as string[], warnings: [] as string[], links: { exact: 0, heuristic: 0 }, complete: true };

  const importBatch = async (orders: ReturnType<typeof OrderImport.parse>[]) => {
    await deps.db.tx(async (tx) => {
      for (const order of orders) {
        const r = await upsertOrder(tx, input.orgId, input.storeId, order);
        if (r.created) out.created++;
        else out.updated++;
        out.warnings.push(...r.warnings);
      }
    });
  };
  const mapEach = <T>(list: T[], map: (o: T) => ReturnType<typeof OrderImport.parse>, label: (o: T) => string) =>
    list.flatMap((o) => {
      try {
        return [map(o)];
      } catch (err) {
        out.skipped.push(`${label(o)}: ${err instanceof z.ZodError ? err.issues.map((i) => i.message).join(", ") : String(err)}`);
        return [];
      }
    });

  try {
    if (creds.kind === "shopify") {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await shopifyPage(deps, creds, { cursor, query: `updated_at:>='${since.toISOString()}'` });
        out.read += result.nodes.length;
        await importBatch(mapEach(result.nodes, mapShopifyOrder, (o) => `Order ${o.name}`));
        if (!result.pageInfo.hasNextPage || !result.pageInfo.endCursor) break;
        cursor = result.pageInfo.endCursor;
        if (page === MAX_PAGES - 1) out.complete = false;
      }
    } else {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await wooPage(deps, creds, page, since);
        out.read += result.orders.length;
        await importBatch(mapEach(result.orders, mapWooOrder, (o) => `Order ${o.number}`));
        if (page >= result.pages) break;
        if (page === MAX_PAGES) out.complete = false;
      }
    }
  } catch (err) {
    await deps.db.query("update commerce_connections set last_error = $3, status = case when $4 then 'invalid' else status end where org_id = $1 and id = $2", [
      input.orgId, input.storeId, err instanceof Error ? err.message : String(err), err instanceof ConflictError && err.code === "STORE_REFUSED",
    ]);
    throw err;
  }
  out.links = await deps.db.tx((tx) => linkOrdersToPayments(tx, input.orgId));
  // Only a complete read moves the mark; otherwise the next sync starts from the same point.
  await deps.db.query("update commerce_connections set last_error = null, status = 'connected', last_synced_at = case when $4 then $3 else last_synced_at end where org_id = $1 and id = $2", [
    input.orgId, input.storeId, startedAt.toISOString(), out.complete,
  ]);
  return out;
}
