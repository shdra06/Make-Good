import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { aiUsage } from "./ai/index.ts";
import { aiMode, config, paypalMode, REFUND_WINDOW_DAYS, ROOT } from "./config.ts";
import { all, get } from "./db.ts";
import { buildDemoOrders, DEMO_INCIDENT, ordersToCsv, seedMock, SHOP } from "./demo.ts";
import { decideClaim, listClaims, submitClaim, type Claim } from "./engine/claims.ts";
import { confirmRules, createIncident, findDuplicateCharges, getIncident, listIncidents, openDuplicateIncident, report } from "./engine/incidents.ts";
import { backfill, importOrdersCsv, ledgerStats } from "./engine/ledger.ts";
import { confirmByCode, listAffected, runMatch, type AffectedRow, type Rules } from "./engine/match.ts";
import { approveBatch, createBatch, events, getBatch, listBatches, listItems, previewBatch, rerouteFailed, runBatch } from "./engine/payments.ts";
import { usd } from "./money.ts";
import { mockPayPal, paypal, PayPalError } from "./paypal/index.ts";

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.text({ type: "text/csv", limit: "8mb" }));
app.use(express.static(path.join(ROOT, "public")));

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const person = (req: Request) => String(req.body?.person || "Asha").slice(0, 40);
const id = (req: Request) => String(req.params.id);

// ------------------------------------------------------------- shop data
async function loadDemoShop() {
  if (!mockPayPal) throw new Error("The demo shop can only be loaded in MOCK mode.");
  const orders = buildDemoOrders();
  const seeded = await seedMock(mockPayPal, orders);
  const imported = importOrdersCsv(ordersToCsv(orders));
  const read = await backfill(DEMO_INCIDENT.paidFrom, new Date().toISOString());
  return { seeded, imported, read };
}

app.get("/api/status", (_req, res) => {
  res.json({
    paypalMode,
    aiMode,
    model: aiMode === "claude" ? config.anthropic.model : null,
    shop: SHOP,
    refundWindowDays: REFUND_WINDOW_DAYS,
    ledger: ledgerStats(),
    demo: paypalMode === "mock" ? { description: DEMO_INCIDENT.description, batch: DEMO_INCIDENT.batch } : null,
    aiUsage,
  });
});

app.post("/api/backfill", wrap(async (req, res) => {
  const to = req.body?.to ? new Date(req.body.to) : new Date();
  const from = req.body?.from ? new Date(req.body.from) : new Date(to.getTime() - 120 * 86400_000);
  res.json(await backfill(from.toISOString(), to.toISOString()));
}));

app.post("/api/orders", wrap((req, res) => {
  const csv = typeof req.body === "string" ? req.body : String(req.body?.csv ?? "");
  res.json(importOrdersCsv(csv));
}));

app.get("/api/demo/orders.csv", (_req, res) => {
  res.type("text/csv").send(ordersToCsv(buildDemoOrders()));
});

// ------------------------------------------------------------- incidents
const incidentView = (incidentId: string) => {
  const inc = getIncident(incidentId);
  if (!inc) return null;
  const counts = all<{ state: string; level: number; n: number; c: number }>("SELECT state, level, COUNT(*) AS n, SUM(owed_cents) AS c FROM affected WHERE incident_id = ? GROUP BY state, level", incidentId);
  return { ...inc, rules: JSON.parse(inc.rules_json) as Rules, counts };
};

app.get("/api/incidents", (_req, res) => res.json(listIncidents().map((i) => incidentView(i.id))));

app.post("/api/incidents", wrap(async (req, res) => {
  const out = await createIncident(String(req.body?.description ?? ""));
  res.json({ incident: incidentView(out.incident.id), unsure: out.unsure });
}));

app.get("/api/incidents/:id", (req, res) => {
  const v = incidentView(id(req));
  if (!v) return res.status(404).json({ error: "Incident not found" });
  res.json(v);
});

app.put("/api/incidents/:id/rules", wrap((req, res) => {
  confirmRules(id(req), req.body.rules as Rules, req.body.title, person(req));
  res.json(incidentView(id(req)));
}));

app.post("/api/incidents/:id/match", wrap((req, res) => {
  const inc = getIncident(id(req));
  if (!inc) return res.status(404).json({ error: "Incident not found" });
  if (inc.status === "draft") return res.status(400).json({ error: "Confirm the rules first." });
  res.json(runMatch(id(req)));
}));

app.get("/api/incidents/:id/affected", (req, res) => res.json(listAffected(id(req))));

app.post("/api/incidents/:id/batches", wrap((req, res) => {
  res.json(createBatch(id(req), String(req.body?.label || "Refund batch"), req.body?.affectedIds));
}));

app.get("/api/incidents/:id/batches", wrap(async (req, res) => {
  const balance = await paypal.getBalance("USD");
  res.json(listBatches(id(req)).map((b) => ({ ...b, preview: { ...previewBatch(b.id), balanceCents: balance }, items: listItems(b.id) })));
}));

app.get("/api/incidents/:id/claims", (req, res) => res.json(listClaims(id(req)).map(claimView)));
app.get("/api/incidents/:id/report", (req, res) => res.json(report(id(req))));

// ------------------------------------------------------------- batches
app.post("/api/batches/:id/approve", wrap((req, res) => res.json(approveBatch(id(req), person(req)))));

app.post("/api/batches/:id/run", wrap((req, res) => {
  const b = getBatch(id(req));
  if (!b) return res.status(404).json({ error: "Batch not found" });
  if (b.state === "done") return res.status(400).json({ error: "This batch has already been sent. Nothing was sent again." });
  if (!["approved", "paused"].includes(b.state)) return res.status(400).json({ error: "Approve the batch before sending it." });
  const inc = getIncident(b.incident_id)!;
  const note = (JSON.parse(inc.rules_json) as Rules).notice || `Refund from ${SHOP.name}`;
  void runBatch(b.id, note).catch((err) => console.error("batch run failed", err));
  res.json({ started: true });
}));

app.post("/api/batches/:id/reroute", wrap((req, res) => res.json(rerouteFailed(id(req)) ?? { none: true })));

app.get("/api/batches/:id/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e: { type: string; data: unknown }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
  const batchId = id(req);
  events.on(batchId, send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    events.off(batchId, send);
  });
});

// ------------------------------------------------------------- claims (reviewer side)
const claimView = (c: Claim) => ({ ...c, flags: JSON.parse(c.flags_json), ai: c.ai_json ? JSON.parse(c.ai_json) : null });

app.post("/api/claims/:id/decision", wrap((req, res) => {
  res.json(claimView(decideClaim(id(req), Boolean(req.body?.approve), person(req), String(req.body?.note ?? ""))));
}));

// ------------------------------------------------------------- always-on scan
app.get("/api/scan/duplicates", (_req, res) => res.json(findDuplicateCharges(new Date(Date.now() - 120 * 86400_000).toISOString())));
app.post("/api/scan/duplicates/open", wrap((req, res) => {
  const pairs = findDuplicateCharges(new Date(Date.now() - 120 * 86400_000).toISOString());
  res.json(incidentView(openDuplicateIncident(pairs, person(req)).id));
}));

// ------------------------------------------------------------- public pages (customers)
const mask = (s: string | null) => (s ? s.replace(/^(.).*(@.*)$/, "$1•••$2") : "");

app.get("/api/public/confirm/:token", (req, res) => {
  const row = get<AffectedRow>("SELECT * FROM affected WHERE confirm_token = ?", String(req.params.token));
  if (!row) return res.status(404).json({ error: "This link is not valid." });
  const inc = getIncident(row.incident_id)!;
  const rules = JSON.parse(inc.rules_json) as Rules;
  res.json({ shop: SHOP.name, title: inc.title, product: rules.sku, state: row.state, name: row.customer_name?.split(" ")[0] ?? "", amount: usd(row.owed_cents), order: row.order_number, statusToken: row.status_token });
});

app.post("/api/public/confirm/:token", wrap((req, res) => {
  const out = confirmByCode(String(req.params.token), String(req.body?.code ?? ""));
  res.json({ ok: out.ok, message: out.message, statusToken: out.row?.status_token });
}));

app.get("/api/public/incident/:id", (req, res) => {
  const inc = getIncident(id(req));
  if (!inc) return res.status(404).json({ error: "Not found" });
  const rules = JSON.parse(inc.rules_json) as Rules;
  res.json({ shop: SHOP.name, title: inc.title, product: rules.sku, needsBatch: Boolean(rules.batch), facts: rules.claimFacts });
});

app.post("/api/public/claims", wrap(async (req, res) => {
  const c = await submitClaim({ incidentId: String(req.body?.incidentId), email: String(req.body?.email ?? ""), orderRef: req.body?.orderRef, batchCode: req.body?.batchCode, text: String(req.body?.text ?? "") });
  res.json({ statusToken: c.status_token, decision: c.decision, note: c.decision_note });
}));

app.get("/api/public/status/:token", (req, res) => {
  const t = String(req.params.token);
  const claim = get<Claim>("SELECT * FROM claim WHERE status_token = ?", t);
  const row = claim?.affected_id ? get<AffectedRow>("SELECT * FROM affected WHERE id = ?", claim.affected_id) : get<AffectedRow>("SELECT * FROM affected WHERE status_token = ?", t);
  if (!claim && !row) return res.status(404).json({ error: "This link is not valid." });
  const item = row ? get<{ kind: string; state: string; paypal_id: string | null; amount_cents: number; updated_at: string }>("SELECT kind, state, paypal_id, amount_cents, updated_at FROM payment_item WHERE affected_id = ? ORDER BY rowid DESC LIMIT 1", row.id) : undefined;
  res.json({
    shop: SHOP.name,
    email: mask(claim?.email ?? row?.email ?? null),
    claim: claim ? { decision: claim.decision, note: claim.decision_note } : null,
    customer: row ? { state: row.state, amount: usd(row.owed_cents) } : null,
    payment: item ? { kind: item.kind, state: item.state, paypalId: item.paypal_id, amount: usd(item.amount_cents), at: item.updated_at, mock: paypalMode === "mock" } : null,
  });
});

// ------------------------------------------------------------- PayPal webhooks
app.post("/webhooks/paypal", wrap(async (req, res) => {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const verified = await paypal.verifyWebhook(headers, req.body);
  console.log(`[webhook] ${req.body?.event_type ?? "?"} ${req.body?.resource?.id ?? ""} verified=${verified}`);
  res.status(verified ? 200 : 400).json({ verified });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof PayPalError) return res.status(502).json({ error: `PayPal said: ${err.issue}`, debugId: err.debugId });
  const message = err instanceof Error ? err.message : String(err);
  res.status(400).json({ error: message });
});

app.listen(config.port, async () => {
  console.log(`Make Good on http://localhost:${config.port} · PayPal: ${paypalMode.toUpperCase()} · AI: ${aiMode === "claude" ? `Claude (${config.anthropic.model})` : "MOCK"}`);
  if (paypalMode === "mock") {
    const d = await loadDemoShop();
    console.log(`Demo shop loaded: ${d.seeded.orders} orders, ${d.read.payments} payments (SAMPLE data in the MOCK PayPal).`);
  }
});
