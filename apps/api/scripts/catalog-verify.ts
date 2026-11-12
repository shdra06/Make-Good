// Checks the Channel3 product catalogue against the real API, with the key in
// apps/api/.env (CHANNEL3_API_KEY). Sends product search words only.
// Steps: the client on its own (search, product detail), then the app's own
// path (search, a person confirms, the saved row, pricing an option with it)
// on the synthetic recall case in an in-memory database.
// Writes .data/catalog-verification.json. Never prints the key.
//
//   npm run catalog:verify

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContainer } from "../src/container.ts";
import { Channel3Catalog, replacementValue } from "../src/modules/catalog/channel3.ts";
import { confirmCatalogProduct, listCatalogReferences, searchCatalog } from "../src/modules/catalog/service.ts";
import { seedRecallScenario } from "../src/modules/demo/seed.ts";
import { createOrganisation, registerUser } from "../src/modules/identity/service.ts";
import { comparePolicies } from "../src/modules/recovery/map.ts";
import { addRuleVersion, runIncidentMatch } from "../src/modules/incidents/service.ts";
import { loadConfig } from "../src/platform/config.ts";
import { openDb } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";

const RESULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".data", "catalog-verification.json");

const lines: Array<{ step: string; ok: boolean | null; detail: string }> = [];
const say = (step: string, ok: boolean | null, detail = "") => {
  lines.push({ step, ok, detail });
  console.log(`  ${ok === null ? "note" : ok ? "ok  " : "FAIL"} ${step}${detail ? `  (${detail})` : ""}`);
};
const usd = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

async function main(): Promise<number> {
  const env = loadConfig();
  if (!env.channel3) {
    say("find a Channel3 key", false, "set CHANNEL3_API_KEY in apps/api/.env");
    return 1;
  }
  const facts: Record<string, unknown> = { at: new Date().toISOString(), baseUrl: env.channel3.baseUrl };

  console.log("1. The client against the real API");
  const client = new Channel3Catalog(env.channel3);
  const queries = ["KitchenAid 5 speed hand mixer", "East Fork pottery mug", "Heath Ceramics dinner plate", "KHM512"];
  const searches: Record<string, unknown> = {};
  for (const q of queries) {
    const t = Date.now();
    const found = await client.search(q, 5);
    const top = found[0];
    const value = top ? replacementValue(top.offers) : null;
    searches[q] = found.slice(0, 3).map((p) => ({ id: p.id, title: p.title, brand: p.brand, offers: p.offers.length }));
    say(`search "${q}"`, found.length > 0, `${found.length} products, ${((Date.now() - t) / 1000).toFixed(1)} s; top: ${top ? `${top.brand ?? "?"} · ${top.title}` : "none"}${value ? `; median ${usd(value.medianMinor, value.currency)} at ${value.retailers} retailers` : ""}`);
  }
  facts.searches = searches;
  const first = (await client.search(queries[0]!, 5))[0];
  if (!first) {
    say("a product to look up", false, "the first search found nothing");
    return 1;
  }
  const detail = await client.product(first.id);
  const value = replacementValue(detail.offers);
  facts.detail = { id: detail.id, title: detail.title, brand: detail.brand, offers: detail.offers, value };
  say("product detail by ID", detail.id === first.id, `${detail.offers.length} offers from ${new Set(detail.offers.map((o) => o.domain)).size} retailers`);
  say("prices parse exactly into minor units", detail.offers.every((o) => Number.isSafeInteger(o.priceMinor)), detail.offers.slice(0, 4).map((o) => `${o.domain} ${usd(o.priceMinor, o.currency)}`).join(", "));
  say("no affiliate buy link is kept", !JSON.stringify(detail).includes("buy.trychannel3.com"));
  say("a replacement value can be worked out", value !== null, value ? `${value.basis}: median ${usd(value.medianMinor, value.currency)}, ${usd(value.minMinor, value.currency)} to ${usd(value.maxMinor, value.currency)}` : "no new offers");

  console.log("\n2. The app's path, on the synthetic recall case (in-memory database, PayPal simulator)");
  const config = loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent" }, { readEnvFiles: false });
  const db = await openDb({ pglite: "memory" });
  await migrate(db);
  const c = await createContainer({ ...config, channel3: env.channel3, gemini: null }, { db, passwordCost: { N: 1024, r: 8, p: 1 }, ai: null });
  const user = await registerUser(c.identity, { email: "catalog-verify@example.com", password: "catalog verify password 1", name: "Olive (test)" });
  const org = await createOrganisation(c.identity, { name: "Emberline Ceramics catalogue check", defaultCurrency: "USD", userId: user.id });
  await c.connections.connectSimulator(org.id, user.id);
  const seeded = await seedRecallScenario({ db, clock: c.clock, connections: c.connections }, { orgId: org.id, userId: user.id });
  const deps = { db, clock: c.clock, catalog: c.catalog };

  const s = await searchCatalog(deps, { orgId: org.id, incidentId: seeded.incidentId, query: queries[0]! });
  const before = (await db.query<{ n: number }>("select count(*)::int as n from catalog_references"))[0]!.n;
  say("search through the app saves nothing", before === 0, `${s.products.length} products`);
  const saved = await confirmCatalogProduct(deps, { orgId: org.id, incidentId: seeded.incidentId, userId: user.id, query: queries[0]!, productId: s.products[0]!.id });
  const list = await listCatalogReferences(db, c.catalog, org.id, seeded.incidentId);
  const ref = list.references[0]!;
  say("a person's confirmation saves one dated row", list.references.length === 1 && ref.id === saved.id, `${ref.brand ?? "?"} · ${ref.title}; median ${ref.median_minor === null ? "none" : usd(ref.median_minor, ref.currency!)}`);
  const audits = (await db.query<{ n: number }>("select count(*)::int as n from audit_events where action = 'evidence.catalog_product_confirmed'"))[0]!.n;
  say("the confirmation is on the audit trail", audits === 1);

  if (ref.median_minor !== null && ref.currency) {
    await addRuleVersion(c.deps, {
      orgId: org.id, incidentId: seeded.incidentId, userId: user.id,
      scope: { type: "product", skus: ["CM-412", "CM-412-GB"], batchCodes: ["K-0719"] },
      compensation: { type: "full_refund" },
    } as Parameters<typeof addRuleVersion>[1]);
    await runIncidentMatch(c.deps, { orgId: org.id, incidentId: seeded.incidentId, userId: user.id, payoutsAvailable: false });
    const priced = await comparePolicies(c.deps, {
      orgId: org.id, incidentId: seeded.incidentId, payoutsAvailable: false,
      policies: [{ key: "replacement", label: "Replacement value per unit", include: ["proven"], askTheRest: false, compensation: { type: "fixed_per_unit", fixedMinor: ref.median_minor, fixedCurrency: ref.currency } }],
    } as Parameters<typeof comparePolicies>[1]);
    const p = (priced as { policies: Array<{ payNow: { customers: number; amount: Record<string, number> } }> }).policies[0]!;
    say("the saved value prices an option (dry run)", p.payNow.customers > 0, `${p.payNow.customers} customers, ${Object.entries(p.payNow.amount).map(([cur, m]) => usd(m, cur)).join(", ")}`);
    const ops = (await db.query<{ n: number }>("select count(*)::int as n from payment_operations"))[0]!.n;
    say("pricing moved no money", ops === 0);
  }

  facts.lines = lines;
  fs.mkdirSync(path.dirname(RESULT), { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify(facts, null, 2));
  console.log(`\nWritten: ${path.relative(process.cwd(), RESULT)}`);
  return lines.some((l) => l.ok === false) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("\nStopped:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
