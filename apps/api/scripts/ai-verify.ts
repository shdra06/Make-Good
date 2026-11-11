// Runs the three AI evidence steps against the REAL model configured in
// apps/api/.env (Anthropic if ANTHROPIC_API_KEY is set, otherwise Gemini).
//
//   npm run ai:verify
//
// The merchant records are the synthetic HM-300 recall case on the PayPal
// simulator; no payment is made. What is checked is the model: does what it
// reads survive the checks, and does it change nothing by itself.
// Results go to apps/api/.data/ai-verification.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContainer } from "../src/container.ts";
import { loadConfig } from "../src/platform/config.ts";
import { openDb } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";
import { seedRecallScenario } from "../src/modules/demo/seed.ts";
import { acceptExtraction, explainCandidate, extractDocument, suggestAliases } from "../src/modules/evidence/service.ts";
import { createOrganisation, registerUser } from "../src/modules/identity/service.ts";
import { runIncidentMatch } from "../src/modules/incidents/service.ts";

const RESULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".data", "ai-verification.json");
const lines: Array<{ step: string; ok: boolean | null; detail: string }> = [];
const say = (step: string, ok: boolean | null, detail = "") => {
  lines.push({ step, ok, detail });
  console.log(`  ${ok === null ? "note" : ok ? "ok  " : "FAIL"} ${step}${detail ? `  (${detail})` : ""}`);
};

async function main(): Promise<number> {
  const env = loadConfig();
  const config = loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent" }, { readEnvFiles: false });
  const db = await openDb({ pglite: "memory" });
  await migrate(db);
  const c = await createContainer({ ...config, anthropicApiKey: env.anthropicApiKey, gemini: env.gemini, model: env.model }, { db, passwordCost: { N: 1024, r: 8, p: 1 } });
  if (!c.ai) {
    say("find a model key", false, "set GEMINI_API_KEY or ANTHROPIC_API_KEY in apps/api/.env");
    return 1;
  }
  console.log(`Model: ${c.ai.model}\n`);
  const user = await registerUser(c.identity, { email: "ai-verify@example.com", password: "ai verify password 1", name: "Olive (test)" });
  const org = await createOrganisation(c.identity, { name: "Kitchen Co AI check", defaultCurrency: "USD", userId: user.id });
  await c.connections.connectSimulator(org.id, user.id);
  const seeded = await seedRecallScenario({ db, clock: c.clock, connections: c.connections }, { orgId: org.id, userId: user.id });
  const deps = { ...c.deps, ai: c.ai };
  const facts: Record<string, unknown> = { model: c.ai.model, at: new Date().toISOString() };

  console.log("1. Read the supplier notice");
  const t1 = Date.now();
  const read = await extractDocument(deps, { orgId: org.id, incidentId: seeded.incidentId, documentId: seeded.documentId, userId: user.id, method: "auto" });
  const out = read.output;
  facts.extraction = out;
  say("the model answered in the required shape", read.method !== "pattern_rules", `${read.method} ${read.model}, ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  say("products read", out.products.length > 0, out.products.map((p) => `${p.code} ${p.included ? "affected" : "not affected"}`).join(", "));
  say("batches read", out.batchCodes.length > 0, out.batchCodes.map((b) => `${b.code} ${b.affected ? "affected" : "not affected"}`).join(", "));
  say("fields dropped by the check", null, out.dropped.length === 0 ? "none" : out.dropped.map((d) => `${d.field} ${d.value}: ${d.why}`).join("; "));
  const want = { skus: ["HM-300", "HM-300-EU"], batch: "B-2217" };
  const scope = out.proposedScope;
  const right = !!scope && want.skus.every((s) => scope.skus.includes(s)) && scope.skus.length === 2 && scope.batchCodes.length === 1 && scope.batchCodes[0] === want.batch;
  say("proposed rules match the notice", right, scope ? `${scope.skus.join(", ")}; batch ${scope.batchCodes.join(", ")}` : "nothing proposed");
  say("dates are read as the supplier's dispatch window, not customer shipping", out.dates.every((d) => d.meaning !== "customer_ship_window"), out.dates.map((d) => `${d.from}..${d.to} ${d.meaning}`).join("; ") || "none");
  say("what the notice does not say", null, out.notStated.join(" | ") || "nothing listed");

  await acceptExtraction(deps, {
    orgId: org.id, incidentId: seeded.incidentId, extractionId: read.id, userId: user.id,
    scope: { type: "product", skus: want.skus, batchCodes: [want.batch], serials: [], orderedFrom: null, orderedTo: null, shippedFrom: null, shippedTo: null, warehouses: [] },
    compensation: { type: "full_refund", includeTax: true, includeShipping: false, minMinor: null, maxMinor: null, rounding: "half_up", allowPayout: false, refundWindowDays: 180 },
  });
  const before = await runIncidentMatch(c.deps, { orgId: org.id, incidentId: seeded.incidentId, userId: user.id, payoutsAvailable: false });

  console.log("\n2. Opinions on product codes written differently");
  const t2 = Date.now();
  const aliases = await suggestAliases(deps, { orgId: org.id, incidentId: seeded.incidentId, withAi: true });
  facts.aliases = aliases.aliases.map((a) => ({ alias: a.alias, ai: a.ai }));
  say("the model answered", aliases.aiUsed, aliases.aiNote ?? `${((Date.now() - t2) / 1000).toFixed(1)} s`);
  const expected: Record<string, string> = { "HM300": "same_product", "Kestrel hand mixer HM-300 white": "same_product", "HM-3000": "different_product" };
  for (const a of aliases.aliases) {
    say(`"${a.alias}" (right answer: ${expected[a.alias] ?? "unknown"})`, a.ai ? a.ai.verdict === expected[a.alias] || a.ai.verdict === "cannot_tell" : null, a.ai ? `${a.ai.verdict}: ${a.ai.reason}` : "no usable opinion (dropped or not given)");
  }
  say("opinions confirmed nothing", aliases.aliases.every((a) => a.status === "suggested"));
  const after = await runIncidentMatch(c.deps, { orgId: org.id, incidentId: seeded.incidentId, userId: user.id, payoutsAvailable: false });
  say("and matched nobody new", after.byDecision.ready_for_approval === before.byDecision.ready_for_approval, `${after.byDecision.ready_for_approval} ready before and after`);

  console.log("\n3. Explain a held record");
  const [held] = await db.query<{ id: string }>(
    "select id from candidates where org_id = $1 and incident_id = $2 and eligibility = 'uncertain' and status = 'proposed' limit 1",
    [org.id, seeded.incidentId],
  );
  const t3 = Date.now();
  const explained = await explainCandidate(deps, { orgId: org.id, candidateId: held!.id });
  facts.explanation = explained;
  say("the model answered", explained.explanation.points.length > 0, `${((Date.now() - t3) / 1000).toFixed(1)} s; ${explained.explanation.points.length} cited points kept, ${explained.dropped} dropped`);
  console.log(`        summary: ${explained.explanation.summary}`);
  for (const p of explained.explanation.points) console.log(`        - ${p.text} [${p.cites.join(", ")}]`);
  console.log(`        would settle it: ${explained.explanation.whatWouldSettleIt}`);
  const [still] = await db.query<{ status: string }>("select status from candidates where id = $1", [held!.id]);
  say("the record is unchanged", still!.status === "proposed");

  await db.close();
  fs.mkdirSync(path.dirname(RESULT), { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify({ ...facts, lines }, null, 2));
  const failed = lines.filter((l) => l.ok === false).length;
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error("\nThe run stopped:", err instanceof Error ? err.message : err);
  process.exit(1);
});
