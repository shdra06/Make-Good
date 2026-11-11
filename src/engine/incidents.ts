// Incidents: describe what went wrong, confirm the rules, and report on progress.
import { draftRules } from "../ai/index.ts";
import { all, get, logEvent, newId, now, run, token, tx } from "../db.ts";
import { usd } from "../money.ts";
import type { Rules } from "./match.ts";

export interface Incident {
  id: string;
  kind: string;
  title: string;
  description: string;
  rules_json: string;
  rules_source: string;
  status: string;
  created_at: string;
}

const catalog = () => all<{ sku: string; name: string }>("SELECT sku, MAX(item_name) AS name FROM order_line GROUP BY sku");

/** Create an incident from a plain-words description. AI drafts the rules; they are not active yet. */
export async function createIncident(description: string): Promise<{ incident: Incident; unsure: string[] }> {
  if (description.trim().length < 20) throw new Error("Please describe what happened in a sentence or two.");
  const cat = catalog();
  if (cat.length === 0) throw new Error("Import the shop's order file first, so the products are known.");
  const draft = await draftRules(description, cat);
  const id = newId("inc");
  run("INSERT INTO incident (id, title, description, rules_json, rules_source, created_at) VALUES (?,?,?,?,?,?)", id, draft.title, description, JSON.stringify(draft.rules), draft.source, now());
  logEvent(id, draft.source === "claude" ? "ai" : "rule", "rules-drafted", `Rules drafted from the description (${draft.source === "claude" ? "by Claude" : "by built-in rules, no AI key set"}). They are a draft until a person confirms them.`);
  return { incident: getIncident(id)!, unsure: draft.unsure };
}

/** The merchant edits and confirms the rules. Only confirmed rules can be matched. */
export function confirmRules(incidentId: string, rules: Rules, title: string | undefined, person: string): Incident {
  const inc = getIncident(incidentId);
  if (!inc) throw new Error("Incident not found");
  if (!rules.sku) throw new Error("Choose the affected product.");
  if (!get("SELECT 1 FROM order_line WHERE sku = ?", rules.sku)) throw new Error(`No orders found for product ${rules.sku}.`);
  if (rules.remedy === "percent" && !(rules.percent! > 0 && rules.percent! <= 100)) throw new Error("The percentage must be between 1 and 100.");
  if (rules.remedy === "fixed" && !(rules.fixedCents! > 0)) throw new Error("Enter the fixed amount.");
  run("UPDATE incident SET rules_json = ?, title = COALESCE(?, title), status = 'confirmed' WHERE id = ?", JSON.stringify(rules), title ?? null, incidentId);
  logEvent(incidentId, "person", "rules-confirmed", `${person} confirmed the rules: product ${rules.sku}${rules.batch ? `, batch ${rules.batch}` : ", every unit"}.`);
  return getIncident(incidentId)!;
}

export const getIncident = (id: string) => get<Incident>("SELECT * FROM incident WHERE id = ?", id);
export const listIncidents = () => all<Incident>("SELECT * FROM incident ORDER BY created_at DESC");

export interface Report {
  byState: Record<string, { count: number; cents: number }>;
  byLevel: Array<{ level: number; count: number; cents: number }>;
  paid: { refunds: number; refundCents: number; payouts: number; payoutCents: number };
  waiting: { count: number; cents: number };
  failed: Array<{ ref: string; kind: string; amount: string; error: string | null }>;
  excluded: Array<{ reason: string; count: number }>;
  claims: Record<string, number>;
  events: Array<{ actor: string; kind: string; detail: string; at: string }>;
}

export function report(incidentId: string): Report {
  const byState: Report["byState"] = {};
  for (const r of all<{ state: string; n: number; c: number }>("SELECT state, COUNT(*) AS n, SUM(owed_cents) AS c FROM affected WHERE incident_id = ? GROUP BY state", incidentId)) byState[r.state] = { count: r.n, cents: r.c };
  const items = all<{ kind: string; state: string; n: number; c: number }>("SELECT kind, state, COUNT(*) AS n, SUM(amount_cents) AS c FROM payment_item WHERE incident_id = ? GROUP BY kind, state", incidentId);
  const pick = (kind: string, state: string) => items.find((i) => i.kind === kind && i.state === state) ?? { n: 0, c: 0 };
  const claims: Record<string, number> = {};
  for (const c of all<{ decision: string; n: number }>("SELECT decision, COUNT(*) AS n FROM claim WHERE incident_id = ? GROUP BY decision", incidentId)) claims[c.decision] = c.n;
  const waiting = items.filter((i) => ["pending", "unclaimed", "queued"].includes(i.state));
  return {
    byState,
    byLevel: all<{ level: number; count: number; cents: number }>("SELECT level, COUNT(*) AS count, SUM(owed_cents) AS cents FROM affected WHERE incident_id = ? AND state != 'excluded' GROUP BY level ORDER BY level", incidentId),
    paid: { refunds: pick("refund", "completed").n, refundCents: pick("refund", "completed").c, payouts: pick("payout", "completed").n, payoutCents: pick("payout", "completed").c },
    waiting: { count: waiting.reduce((s, i) => s + i.n, 0), cents: waiting.reduce((s, i) => s + i.c, 0) },
    failed: all<{ ref_key: string; kind: string; amount_cents: number; error: string | null }>(
      "SELECT a.ref_key, p.kind, p.amount_cents, p.error FROM payment_item p JOIN affected a ON a.id = p.affected_id WHERE p.incident_id = ? AND p.state = 'failed'",
      incidentId,
    ).map((f) => ({ ref: f.ref_key, kind: f.kind, amount: usd(f.amount_cents), error: f.error })),
    excluded: all<{ reason: string; count: number }>("SELECT excluded_reason AS reason, COUNT(*) AS count FROM affected WHERE incident_id = ? AND state = 'excluded' GROUP BY excluded_reason", incidentId),
    claims,
    events: all<{ actor: string; kind: string; detail: string; at: string }>("SELECT actor, kind, detail, at FROM event_log WHERE incident_id = ? OR incident_id IS NULL ORDER BY id DESC LIMIT 60", incidentId),
  };
}

// ------------------------------------------------------------------ always-on scan: duplicate charges

export interface DuplicatePair {
  first: string;
  second: string;
  email: string;
  name: string;
  amount: string;
  minutesApart: number;
}

/** Find customers charged twice: same payer, same amount, within 10 minutes. Plain rule, no AI. */
export function findDuplicateCharges(sinceIso: string): DuplicatePair[] {
  const rows = all<{ a: string; b: string; payer_email: string; payer_name: string; amount_cents: number; ta: string; tb: string }>(
    `SELECT x.txn_id AS a, y.txn_id AS b, x.payer_email, x.payer_name, x.amount_cents, x.paid_at AS ta, y.paid_at AS tb
     FROM paypal_txn x JOIN paypal_txn y
       ON x.payer_email = y.payer_email AND x.amount_cents = y.amount_cents AND x.txn_id != y.txn_id AND x.paid_at < y.paid_at
     WHERE x.paid_at >= ? AND x.payer_email != '' AND y.refunded_cents = 0
       AND (julianday(y.paid_at) - julianday(x.paid_at)) * 1440 <= 10`,
    sinceIso,
  );
  return rows.map((r) => ({ first: r.a, second: r.b, email: r.payer_email, name: r.payer_name, amount: usd(r.amount_cents), minutesApart: Math.round((Date.parse(r.tb) - Date.parse(r.ta)) / 60000) }));
}

/** Turn the duplicates found into an incident whose affected list is the second charge of each pair. */
export function openDuplicateIncident(pairs: DuplicatePair[], person: string): Incident {
  if (pairs.length === 0) throw new Error("No duplicate charges were found.");
  const id = newId("inc");
  const rules: Rules = { sku: "", batch: null, paidFrom: null, paidTo: null, shipFrom: null, shipTo: null, remedy: "full_line", capCents: null, claimFacts: [], notice: "We charged you twice by mistake. We have refunded the second charge in full. We are sorry." };
  tx(() => {
    run("INSERT INTO incident (id, kind, title, description, rules_json, rules_source, status, created_at) VALUES (?,?,?,?,?,?,?,?)", id, "duplicate", "Duplicate charges", `${pairs.length} customers were charged twice within 10 minutes.`, JSON.stringify(rules), "rule", "matched", now());
    for (const p of pairs) {
      const t = get<{ amount_cents: number; paid_at: string; disputed: number }>("SELECT amount_cents, paid_at, disputed FROM paypal_txn WHERE txn_id = ?", p.second)!;
      run(
        `INSERT INTO affected (id, incident_id, ref_key, txn_id, email, customer_name, paid_at, level, match_kind, owed_cents, why, state, excluded_reason, confirm_token, status_token)
         VALUES (?,?,?,?,?,?,?,1,'invoice',?,?,?,?,?,?)`,
        newId("af"), id, p.second, p.second, p.email, p.name, t.paid_at, t.amount_cents,
        `Charged ${p.amount} twice, ${p.minutesApart} minutes apart. This is the second charge.`,
        t.disputed ? "excluded" : "ready", t.disputed ? "A dispute is open on this payment" : null, token(), token(),
      );
    }
  });
  logEvent(id, "rule", "scan", `Duplicate-charge scan found ${pairs.length} double charges; ${person} opened an incident for them.`);
  return getIncident(id)!;
}
