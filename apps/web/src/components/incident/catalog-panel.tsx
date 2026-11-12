"use client";

// Product catalogue evidence (Channel3): find the recalled product in an
// outside catalogue, and save the one a person confirms with what a new unit
// costs at retailers today. Only the search words leave Make Good.

import { Loader2, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Panel, Tag } from "@/components/incident/bits";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day, money } from "@/lib/format";
import { useOrgAction } from "@/lib/org-action";
import type { CatalogList, CatalogSearchResult, ReplacementValue } from "@/lib/types";

const range = (v: { medianMinor: number; minMinor: number; maxMinor: number; currency: string }) =>
  v.minMinor === v.maxMinor
    ? money(v.medianMinor, v.currency)
    : `${money(v.medianMinor, v.currency)} (from ${money(v.minMinor, v.currency)} to ${money(v.maxMinor, v.currency)})`;

function Value({ v }: { v: ReplacementValue | null }) {
  if (!v) return <span className="text-muted-foreground">No new offers found</span>;
  return (
    <span>
      {range(v)} · {v.basis === "new_in_stock" ? "new, in stock" : "new, none in stock"} at {v.retailers} retailer{v.retailers === 1 ? "" : "s"}
    </span>
  );
}

export function CatalogPanel({ incUrl, listKey, list, canWrite }: { incUrl: string; listKey: unknown[]; list: CatalogList; canWrite: boolean }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<CatalogSearchResult | null>(null);
  const search = useOrgAction();
  const confirm = useOrgAction([listKey]);
  const latest = list.references[0] ?? null;

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    const r = await search.run(() => api.post<CatalogSearchResult>(`${incUrl}/catalog/search`, { query }));
    if (r) setResult(r);
  };

  return (
    <Panel
      className="mb-5"
      testId="catalog"
      title="Replacement value from a product catalogue"
      hint="Find the recalled product in Channel3's catalogue of retailers, and confirm the right one. Make Good saves what a new unit costs today, dated, as evidence for pricing an option. Only your search words are sent."
      actions={<Tag tone="info">Channel3 · outside data</Tag>}
    >
      {!list.configured ? (
        <p className="text-sm text-muted-foreground">The product catalogue is off. Set CHANNEL3_API_KEY on the server to look products up.</p>
      ) : (
        <>
          {latest ? (
            <div className="mb-4 rounded-md border bg-muted/40 p-3 text-sm" data-testid="catalog-latest">
              <p className="font-medium">
                {latest.brand ? `${latest.brand} · ` : ""}
                {latest.title}
              </p>
              <p>
                {latest.currency && latest.median_minor !== null && latest.min_minor !== null && latest.max_minor !== null
                  ? `${range({ medianMinor: latest.median_minor, minMinor: latest.min_minor, maxMinor: latest.max_minor, currency: latest.currency })} at ${latest.retailer_count} retailer${latest.retailer_count === 1 ? "" : "s"}`
                  : "No new offers were found when it was looked up."}
              </p>
              <p className="text-xs text-muted-foreground">
                Looked up {day(latest.retrieved_at)}, confirmed by {latest.confirmed_by_name ?? "a member of staff"}. Prices change: look it up again before a
                decision.
              </p>
            </div>
          ) : null}
          {canWrite ? (
            <form onSubmit={onSearch} className="flex max-w-xl flex-col gap-1.5">
              <Label htmlFor="catalog-query">Product name, as a shopper would type it</Label>
              <div className="flex gap-2">
                <Input
                  id="catalog-query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="For example: Emberline ceramic mug 12 oz"
                  minLength={2}
                  required
                />
                <Button type="submit" variant="outline" disabled={search.pending || query.trim().length < 2}>
                  {search.pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />} Search
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">The product&apos;s name and brand work best. A model code alone may find the wrong item.</p>
            </form>
          ) : null}
          {result ? (
            <ul className="mt-4 flex flex-col divide-y rounded-md border" data-testid="catalog-results">
              {result.products.length === 0 ? <li className="p-3 text-sm text-muted-foreground">Nothing found for “{result.query}”.</li> : null}
              {result.products.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {p.brand ? `${p.brand} · ` : ""}
                      {p.title}
                    </p>
                    <p className="text-muted-foreground">
                      <Value v={p.replacementValue} />
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={confirm.pending}
                    onClick={async () => {
                      const r = await confirm.run(
                        () => api.post(`${incUrl}/catalog/confirm`, { query: result.query, productId: p.id }),
                        "Saved as evidence, in your name. Prices were read again just now.",
                      );
                      if (r) setResult(null);
                    }}
                  >
                    This is the recalled product
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Panel>
  );
}
