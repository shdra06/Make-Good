// Channel3: a product catalogue of many retailers (REST API, api.trychannel3.com).
//
// Used for evidence only: what a recalled product is, and what a new one costs
// at retailers today. It never decides who is affected or what is paid.
// Only product words are sent: never a customer's name, email or order.

import { AppError } from "../../platform/errors.ts";
import { isCurrencyCode, toMinor } from "../../platform/money.ts";

export type CatalogOffer = {
  /** The retailer's domain. Channel3's buy links carry affiliate tracking and are not stored. */
  domain: string;
  priceMinor: number;
  currency: string;
  availability: string | null;
  condition: string | null;
};

export type CatalogProduct = {
  id: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  offers: CatalogOffer[];
};

export interface ProductCatalog {
  readonly source: "channel3";
  search(query: string, limit?: number): Promise<CatalogProduct[]>;
  product(id: string): Promise<CatalogProduct>;
}

/** The catalogue answered with an error, timed out, or could not be reached. Nothing was saved. */
export class CatalogError extends AppError {
  constructor(message: string, status = 502, details?: Record<string, unknown>) {
    super("CATALOG_UNAVAILABLE", status, message, details);
    this.name = "CatalogError";
  }
}

type RawOffer = {
  domain?: unknown;
  price?: { price?: unknown; currency?: unknown } | null;
  availability?: unknown;
  condition?: unknown;
};
type RawProduct = {
  id?: unknown;
  title?: unknown;
  brands?: Array<{ name?: unknown }> | null;
  images?: Array<{ url?: unknown }> | null;
  offers?: RawOffer[] | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function toOffer(o: RawOffer): CatalogOffer | null {
  const domain = str(o.domain);
  const currency = str(o.price?.currency);
  const price = o.price?.price;
  if (!domain || !currency || !isCurrencyCode(currency) || typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  try {
    return { domain, priceMinor: toMinor(String(price), currency), currency, availability: str(o.availability), condition: str(o.condition) };
  } catch {
    return null; // more decimal places than the currency has: leave the offer out rather than round it
  }
}

export function toCatalogProduct(p: RawProduct): CatalogProduct | null {
  const id = str(p.id);
  const title = str(p.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    brand: str(p.brands?.[0]?.name),
    imageUrl: str(p.images?.[0]?.url),
    offers: (p.offers ?? []).map(toOffer).filter((o): o is CatalogOffer => o !== null),
  };
}

export class Channel3Catalog implements ProductCatalog {
  readonly source = "channel3" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? "https://api.trychannel3.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "x-api-key": this.opts.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new CatalogError(`The product catalogue could not be reached: ${err instanceof Error ? err.message : String(err)}`, 504);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "5");
      throw new CatalogError("The product catalogue is busy. Try again in a few seconds.", 429, { retryAfterSeconds: Number.isFinite(retry) ? retry : 5 });
    }
    if (res.status === 401 || res.status === 403) throw new CatalogError("The product catalogue refused the API key. Check CHANNEL3_API_KEY.", 502);
    if (res.status === 404) throw new CatalogError("The catalogue has no such product.", 404);
    if (!res.ok) throw new CatalogError(`The product catalogue answered ${res.status}.`, 502);
    return res.json();
  }

  async search(query: string, limit = 8): Promise<CatalogProduct[]> {
    const body = (await this.call("POST", "/v1/search", { query, limit })) as { products?: RawProduct[] };
    return (body.products ?? []).map(toCatalogProduct).filter((p): p is CatalogProduct => p !== null);
  }

  async product(id: string): Promise<CatalogProduct> {
    const raw = (await this.call("GET", `/v1/products/${encodeURIComponent(id)}`)) as RawProduct;
    const p = toCatalogProduct(raw);
    if (!p) throw new CatalogError("The catalogue's answer had no product ID or title.", 502);
    return p;
  }
}

export type ReplacementValue = {
  currency: string;
  /** Which offers the figures use: new and in stock if there are any, otherwise every new offer. */
  basis: "new_in_stock" | "new_any";
  offers: number;
  retailers: number;
  medianMinor: number;
  minMinor: number;
  maxMinor: number;
};

/**
 * What a new unit costs at retailers, from the offers of one catalogue product.
 * Uses the currency with the most offers. The median of an even count is the
 * lower middle value, so the figure is always a price a retailer actually asked.
 */
export function replacementValue(offers: CatalogOffer[]): ReplacementValue | null {
  const fresh = offers.filter((o) => (o.condition ?? "new").toLowerCase() === "new");
  const inStock = fresh.filter((o) => (o.availability ?? "").toLowerCase() === "instock");
  const basis = inStock.length ? "new_in_stock" : "new_any";
  const pool = inStock.length ? inStock : fresh;
  if (pool.length === 0) return null;
  const byCurrency = new Map<string, CatalogOffer[]>();
  for (const o of pool) byCurrency.set(o.currency, [...(byCurrency.get(o.currency) ?? []), o]);
  const [currency, chosen] = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]!;
  const prices = chosen.map((o) => o.priceMinor).sort((a, b) => a - b);
  return {
    currency,
    basis,
    offers: prices.length,
    retailers: new Set(chosen.map((o) => o.domain.toLowerCase())).size,
    medianMinor: prices[Math.floor((prices.length - 1) / 2)]!,
    minMinor: prices[0]!,
    maxMinor: prices[prices.length - 1]!,
  };
}
