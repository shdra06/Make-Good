// Product catalogue evidence for an incident: search the catalogue for the
// recalled product, and save the one a named person confirms, with what a new
// unit costs at retailers today. The saved row is evidence for pricing a
// replacement-value option on the Options step; it changes no record and pays nothing.

import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { NotConfiguredError, NotFoundError } from "../../platform/errors.ts";
import { replacementValue, type CatalogProduct, type ProductCatalog } from "./channel3.ts";

type Deps = { db: Db; clock: Clock; catalog: ProductCatalog | null };

export const CatalogSearch = z.object({ query: z.string().trim().min(2).max(200) });
export const CatalogConfirm = z.object({ query: z.string().trim().min(2).max(200), productId: z.string().trim().min(1).max(200) });

function need(catalog: ProductCatalog | null): ProductCatalog {
  if (!catalog) throw new NotConfiguredError("CATALOG_NOT_CONFIGURED", "No product catalogue is configured. Set CHANNEL3_API_KEY to look products up.");
  return catalog;
}

async function assertIncident(q: Queryable, orgId: string, incidentId: string): Promise<void> {
  const rows = await q.query("select 1 from incidents where org_id = $1 and id = $2", [orgId, incidentId]);
  if (rows.length === 0) throw new NotFoundError("Incident");
}

const view = (p: CatalogProduct) => ({ id: p.id, title: p.title, brand: p.brand, imageUrl: p.imageUrl, replacementValue: replacementValue(p.offers) });

/** Search only: nothing is saved. Sends the query words to the catalogue, nothing else. */
export async function searchCatalog(deps: Deps, input: { orgId: string; incidentId: string; query: string }) {
  const catalog = need(deps.catalog);
  await assertIncident(deps.db, input.orgId, input.incidentId);
  const products = await catalog.search(input.query, 8);
  return { source: catalog.source, query: input.query, retrievedAt: deps.clock.now().toISOString(), products: products.map(view) };
}

/** A person says which catalogue product is the recalled one. Its offers are read again now and saved, dated. */
export async function confirmCatalogProduct(deps: Deps, input: { orgId: string; incidentId: string; userId: string; query: string; productId: string }) {
  const catalog = need(deps.catalog);
  await assertIncident(deps.db, input.orgId, input.incidentId);
  const product = await catalog.product(input.productId); // outside any transaction: no network call holds a lock
  const value = replacementValue(product.offers);
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into catalog_references (org_id, incident_id, source, query, product_id, title, brand, offers, basis, currency,
                                       offer_count, retailer_count, median_minor, min_minor, max_minor, retrieved_at, confirmed_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $16) returning id`,
      [
        input.orgId, input.incidentId, catalog.source, input.query, product.id, product.title, product.brand, JSON.stringify(product.offers),
        value?.basis ?? null, value?.currency ?? null, value?.offers ?? 0, value?.retailers ?? 0,
        value?.medianMinor ?? null, value?.minMinor ?? null, value?.maxMinor ?? null, now.toISOString(), input.userId,
      ],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "evidence.catalog_product_confirmed", entityType: "incident",
      entityId: input.incidentId,
      data: { referenceId: row!.id, source: catalog.source, productId: product.id, title: product.title, currency: value?.currency ?? null, medianMinor: value?.medianMinor ?? null, offers: value?.offers ?? 0 },
      at: now,
    });
    return { id: row!.id, product: view(product), retrievedAt: now.toISOString() };
  });
}

export type CatalogReferenceRow = {
  id: string; source: string; query: string; product_id: string; title: string; brand: string | null;
  basis: string | null; currency: string | null; offer_count: number; retailer_count: number;
  median_minor: number | null; min_minor: number | null; max_minor: number | null;
  offers: unknown; retrieved_at: Date; confirmed_by_name: string | null;
};

/** Every confirmed reference for the incident, newest first, and whether a catalogue is configured at all. */
export async function listCatalogReferences(q: Queryable, catalog: ProductCatalog | null, orgId: string, incidentId: string) {
  await assertIncident(q, orgId, incidentId);
  const rows = await q.query<CatalogReferenceRow>(
    `select r.id, r.source, r.query, r.product_id, r.title, r.brand, r.basis, trim(r.currency) as currency, r.offer_count, r.retailer_count,
            r.median_minor, r.min_minor, r.max_minor, r.offers, r.retrieved_at, u.name as confirmed_by_name
       from catalog_references r left join users u on u.id = r.confirmed_by
      where r.org_id = $1 and r.incident_id = $2
      order by r.created_at desc, r.id desc`,
    [orgId, incidentId],
  );
  return {
    configured: catalog !== null,
    source: "channel3",
    meaning: "An outside product catalogue. Prices are what retailers asked when it was looked up; they are evidence for pricing an option, not a payment.",
    references: rows.map((r) => ({ ...r, median_minor: r.median_minor === null ? null : Number(r.median_minor), min_minor: r.min_minor === null ? null : Number(r.min_minor), max_minor: r.max_minor === null ? null : Number(r.max_minor) })),
  };
}
