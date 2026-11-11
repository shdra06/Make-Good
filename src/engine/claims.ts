// The claims lane: for people the records cannot see.
// Order of checks: (1) the merchant's own records, (2) simple duplicate and look-alike rules,
// (3) an AI reading for the human reviewer. Only an exact duplicate is rejected automatically.
// Everything uncertain goes to a person. A claim is never paid without a person's approval.
import { readClaim } from "../ai/index.ts";
import { all, get, logEvent, newId, now, run, token } from "../db.ts";
import { usd } from "../money.ts";
import type { AffectedRow, Rules } from "./match.ts";

export interface Claim {
  id: string;
  incident_id: string;
  email: string;
  order_ref: string | null;
  batch_code: string | null;
  text: string;
  match_status: string;
  affected_id: string | null;
  ai_json: string | null;
  flags_json: string;
  decision: string;
  decided_by: string | null;
  decision_note: string | null;
  status_token: string;
  created_at: string;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out;
}
function similarity(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / (x.size + y.size - both);
}

export interface ClaimInput {
  incidentId: string;
  email: string;
  orderRef?: string | null;
  batchCode?: string | null;
  text: string;
}

export async function submitClaim(input: ClaimInput): Promise<Claim> {
  const inc = get<{ rules_json: string }>("SELECT rules_json FROM incident WHERE id = ?", input.incidentId);
  if (!inc) throw new Error("Incident not found");
  const rules = JSON.parse(inc.rules_json) as Rules;
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Please enter a valid email address.");
  const text = input.text.trim().slice(0, 4000);
  if (text.length < 10) throw new Error("Please tell us what happened in a sentence or two.");
  const orderRef = input.orderRef?.trim() || null;
  const batchCode = input.batchCode?.trim() || null;

  const flags: string[] = [];
  let matchStatus = "unmatched";
  let decision = "review";
  let note: string | null = null;
  let affectedId: string | null = null;

  // ---- 1. Has this exact claim been made before? ----
  const earlier = all<Claim>("SELECT * FROM claim WHERE incident_id = ?", input.incidentId);
  const sameClaim = earlier.find((c) => c.email === email && norm(c.order_ref) === norm(orderRef) && c.decision !== "rejected");
  // ---- 2. What do the merchant's records say? ----
  const row =
    (orderRef ? get<AffectedRow>("SELECT * FROM affected WHERE incident_id = ? AND (order_number = ? OR ref_key = ?)", input.incidentId, orderRef, orderRef) : undefined) ??
    get<AffectedRow>("SELECT * FROM affected WHERE incident_id = ? AND email = ? ORDER BY level LIMIT 1", input.incidentId, email);

  if (sameClaim) {
    matchStatus = "duplicate";
    decision = "rejected";
    note = "You have already filed this claim. Its status page shows where it stands.";
  } else if (row) {
    affectedId = row.id;
    if (["paid", "queued"].includes(row.state)) {
      matchStatus = "duplicate";
      decision = "rejected";
      note = row.state === "paid" ? `This order was already refunded (${usd(row.owed_cents)}).` : "A refund for this order is already on its way.";
    } else if (["ready", "confirmed"].includes(row.state)) {
      matchStatus = "matched";
      decision = "moved-to-records";
      note = "We already have you on our list. You do not need a claim; your refund is being prepared.";
    } else if (row.state === "needs_confirm" && rules.batch && batchCode) {
      matchStatus = "matched";
      if (norm(batchCode) === norm(rules.batch)) {
        run("UPDATE affected SET state = 'confirmed' WHERE id = ?", row.id);
        decision = "moved-to-records";
        note = `Your batch code matches ${rules.batch}. Your refund is being prepared.`;
      } else {
        flags.push(`The batch code given (${batchCode.slice(0, 20)}) is not the affected batch.`);
      }
    } else {
      matchStatus = "matched";
      if (row.state === "excluded") flags.push(`Our records exclude this order: ${row.excluded_reason}.`);
      if (row.state === "declined") flags.push("An earlier batch-code check said this unit is not affected.");
      if (row.state === "needs_confirm") flags.push("We have this order, but need the batch code to confirm it.");
    }
  } else {
    flags.push("No matching order or payment in the merchant's records.");
  }

  // ---- 3. Look-alike rules (plain code) ----
  const twins = earlier.filter((c) => c.email !== email && similarity(c.text, text) >= 0.6);
  if (twins.length) flags.push(`The wording is very close to ${twins.length} other claim${twins.length > 1 ? "s" : ""}.`);
  const sameEmail = earlier.filter((c) => c.email === email).length;
  if (sameEmail >= 2) flags.push(`${sameEmail} earlier claims came from this email address.`);
  if (!orderRef && !batchCode) flags.push("No order number and no batch code were given.");

  // ---- 4. AI reading for the reviewer (only when a person will look at it) ----
  let ai: Awaited<ReturnType<typeof readClaim>> | null = null;
  if (decision === "review") {
    ai = await readClaim({ text, orderRef, batchCode }, rules.claimFacts.length ? rules.claimFacts : ["Proof of purchase"]);
    flags.push(...ai.concerns);
  }

  const id = newId("cl");
  run(
    "INSERT INTO claim (id, incident_id, email, order_ref, batch_code, text, match_status, affected_id, ai_json, flags_json, decision, decided_by, decision_note, status_token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, input.incidentId, email, orderRef, batchCode, text, matchStatus, affectedId, ai ? JSON.stringify(ai) : null, JSON.stringify(flags), decision, decision === "review" ? null : "rule", note, token(), now(),
  );
  logEvent(input.incidentId, decision === "review" ? (ai?.source === "claude" ? "ai" : "rule") : "rule", "claim", `Claim from ${email}: ${matchStatus}; ${decision === "review" ? "sent to a person for review" : decision}.`);
  return get<Claim>("SELECT * FROM claim WHERE id = ?", id)!;
}

export const listClaims = (incidentId: string) => all<Claim>("SELECT * FROM claim WHERE incident_id = ? ORDER BY created_at DESC", incidentId);

/** A person decides a claim that was sent to review. Approving adds the claimant to the payout queue. */
export function decideClaim(claimId: string, approve: boolean, person: string, note: string): Claim {
  const c = get<Claim>("SELECT * FROM claim WHERE id = ?", claimId);
  if (!c) throw new Error("Claim not found");
  if (c.decision !== "review") throw new Error(`This claim is already ${c.decision}.`);
  if (approve) {
    const rules = JSON.parse(get<{ rules_json: string }>("SELECT rules_json FROM incident WHERE id = ?", c.incident_id)!.rules_json) as Rules;
    const existing = c.affected_id ? get<AffectedRow>("SELECT * FROM affected WHERE id = ?", c.affected_id) : undefined;
    if (existing && ["needs_confirm", "declined", "excluded"].includes(existing.state)) {
      run("UPDATE affected SET state = 'confirmed', why = why || ' Approved on claim by ' || ? || '.' WHERE id = ?", person, existing.id);
    } else if (!existing) {
      // No record of this person: a level-5 entry, paid by payout, capped at the product's price.
      const price = get<{ c: number }>("SELECT MAX(unit_cents) AS c FROM order_line WHERE sku = ?", rules.sku)?.c ?? 0;
      const owed = rules.capCents !== null ? Math.min(price, rules.capCents) : price;
      const afId = newId("af");
      run(
        `INSERT INTO affected (id, incident_id, ref_key, email, customer_name, level, match_kind, owed_cents, why, state, confirm_token, status_token)
         VALUES (?,?,?,?,?,5,'claim',?,?,'confirmed',?,?)`,
        afId, c.incident_id, `claim:${c.id}`, c.email, c.email, owed, `No record in PayPal or the order file. Claim approved by ${person}: ${note || "no note"}.`, token(), c.status_token + "a",
      );
      run("UPDATE claim SET affected_id = ? WHERE id = ?", afId, c.id);
    }
  }
  run("UPDATE claim SET decision = ?, decided_by = ?, decision_note = ? WHERE id = ?", approve ? "approved" : "rejected", person, note || null, claimId);
  logEvent(c.incident_id, "person", "claim-decided", `${person} ${approve ? "approved" : "rejected"} the claim from ${c.email}${note ? `: ${note}` : ""}.`);
  return get<Claim>("SELECT * FROM claim WHERE id = ?", claimId)!;
}
