// Step 2: work out who is affected, how sure we are, and what each customer is owed.
// Plain code only. PayPal never knows the batch, so the batch comes from the shop's order data,
// and every customer gets a precision level:
//   1 exact unit · 2 batch by date · 3 product only · 4 amount and date only · 5 no record (claims)
import { all, get, logEvent, newId, run, token, tx } from "../db.ts";
import { pct, usd } from "../money.ts";

export interface Rules {
  sku: string;
  /** The affected batch code, or null when every unit of the product in the date range is affected. */
  batch: string | null;
  paidFrom: string | null;
  paidTo: string | null;
  /** When the affected batch was shipped. Used for level 2 when no batch was recorded. */
  shipFrom: string | null;
  shipTo: string | null;
  remedy: "full_line" | "percent" | "fixed";
  percent?: number;
  fixedCents?: number;
  /** Most that one customer can receive, or null for no cap. */
  capCents: number | null;
  /** What a claimant with no record must show. */
  claimFacts: string[];
  /** Message to customers. */
  notice: string;
}

interface OrderLine {
  order_number: string;
  email: string | null;
  customer_name: string | null;
  paid_at: string;
  sku: string;
  qty: number;
  unit_cents: number;
  line_discount_cents: number;
  order_total_cents: number;
  shipped_at: string | null;
  batch_code: string | null;
  paid_via: string;
}
interface Txn {
  txn_id: string;
  payer_email: string;
  payer_name: string;
  amount_cents: number;
  paid_at: string;
  invoice_id: string | null;
  items_json: string;
  refunded_cents: number;
  disputed: number;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
const day = (iso: string) => iso.slice(0, 10);

function remedyFor(rules: Rules, lineCents: number): number {
  let owed = rules.remedy === "percent" ? pct(lineCents, rules.percent ?? 100) : rules.remedy === "fixed" ? Math.min(lineCents, rules.fixedCents ?? 0) : lineCents;
  if (rules.capCents !== null) owed = Math.min(owed, rules.capCents);
  return owed;
}

export interface MatchSummary {
  considered: number;
  differentBatch: number;
  shippedOutsideWindow: number;
  noPayPalPayment: number;
  byLevel: Record<string, { count: number; owedCents: number }>;
  excluded: Record<string, number>;
  ready: { count: number; owedCents: number };
  needsConfirm: { count: number; owedCents: number };
}

export function runMatch(incidentId: string): MatchSummary {
  const inc = get<{ rules_json: string }>("SELECT rules_json FROM incident WHERE id = ?", incidentId);
  if (!inc) throw new Error("Incident not found");
  const rules = JSON.parse(inc.rules_json) as Rules;
  const from = rules.paidFrom ?? "0000";
  const to = rules.paidTo ?? "9999";

  const lines = all<OrderLine>("SELECT * FROM order_line WHERE sku = ? AND paid_at >= ? AND paid_at <= ? ORDER BY paid_at", rules.sku, from, to);
  const txns = all<Txn>("SELECT * FROM paypal_txn WHERE paid_at >= ? AND paid_at <= ?", from, to);
  const byInvoice = new Map(txns.filter((t) => t.invoice_id).map((t) => [t.invoice_id!, t]));
  const noInvoice = txns.filter((t) => !t.invoice_id);
  const allOrderNumbers = new Set(all<{ order_number: string }>("SELECT DISTINCT order_number FROM order_line").map((r) => r.order_number));
  const used = new Set<string>();

  const summary: MatchSummary = { considered: lines.length, differentBatch: 0, shippedOutsideWindow: 0, noPayPalPayment: 0, byLevel: {}, excluded: {}, ready: { count: 0, owedCents: 0 }, needsConfirm: { count: 0, owedCents: 0 } };

  interface Row {
    refKey: string;
    txn: Txn | null;
    order: string | null;
    email: string | null;
    name: string | null;
    paidAt: string;
    level: number;
    matchKind: string;
    owed: number;
    why: string;
    state: string;
    excludedReason: string | null;
  }
  const out: Row[] = [];

  for (const l of lines) {
    // ---- which batch did this unit come from? ----
    let level: number;
    let why: string;
    if (!rules.batch) {
      level = 1;
      why = "Every unit of this product in the date range is affected.";
    } else if (l.batch_code) {
      if (norm(l.batch_code) !== norm(rules.batch)) {
        summary.differentBatch++;
        continue;
      }
      level = 1;
      why = `Batch ${l.batch_code} is recorded on the order line.`;
    } else if (l.shipped_at && rules.shipFrom && rules.shipTo) {
      if (l.shipped_at < rules.shipFrom || l.shipped_at > rules.shipTo) {
        summary.shippedOutsideWindow++;
        continue;
      }
      level = 2;
      why = `No batch recorded. Shipped ${day(l.shipped_at)}, while batch ${rules.batch} was being shipped.`;
    } else {
      level = 3;
      why = "The order shows the product, but no batch and no usable ship date.";
    }

    // ---- which PayPal payment paid for it? ----
    let txn: Txn | null = byInvoice.get(l.order_number) ?? null;
    let matchKind = "invoice";
    if (!txn && l.paid_via === "paypal") {
      txn =
        noInvoice.find(
          (t) => !used.has(t.txn_id) && t.payer_email === (l.email ?? "") && t.amount_cents === l.order_total_cents && Math.abs(Date.parse(t.paid_at) - Date.parse(l.paid_at)) <= 10 * 60_000,
        ) ?? null;
      matchKind = "fallback";
    }
    if (txn) used.add(txn.txn_id);

    const lineCents = l.unit_cents * l.qty - l.line_discount_cents;
    let owed = remedyFor(rules, lineCents);
    let state = level === 1 ? "ready" : "needs_confirm";
    let excludedReason: string | null = null;

    if (!txn && l.paid_via !== "paypal") {
      matchKind = "outside";
      why += " Paid outside PayPal, so the money can only go by payout to this email.";
    } else if (!txn) {
      summary.noPayPalPayment++;
      state = "excluded";
      excludedReason = "No PayPal payment found for this order";
    } else {
      const left = txn.amount_cents - txn.refunded_cents;
      if (txn.disputed) {
        state = "excluded";
        excludedReason = "A dispute is open on this payment";
      } else if (left <= 0) {
        state = "excluded";
        excludedReason = "Already refunded in full";
      } else if (owed > left) {
        why += ` Limited to ${usd(left)}, the part of the payment not yet refunded.`;
        owed = left;
      }
      if (matchKind === "fallback") why += " Matched to the payment by email, amount and time (lower confidence).";
    }
    out.push({ refKey: l.order_number, txn, order: l.order_number, email: l.email, name: l.customer_name, paidAt: l.paid_at, level, matchKind, owed, why, state, excludedReason });
  }

  // ---- PayPal payments with no order in the export ----
  const price = get<{ c: number }>("SELECT MAX(unit_cents) AS c FROM order_line WHERE sku = ?", rules.sku)?.c ?? 0;
  for (const t of txns) {
    if (used.has(t.txn_id) || (t.invoice_id && allOrderNumbers.has(t.invoice_id))) continue;
    // The payment may belong to an order we already ruled out (another batch, shipped outside the
    // window). If any order fits it by email, amount and time, it is not an unknown payment.
    const known = get(
      "SELECT 1 FROM order_line WHERE email = ? AND order_total_cents = ? AND ABS(julianday(paid_at) - julianday(?)) * 1440 <= 10 LIMIT 1",
      t.payer_email, t.amount_cents, t.paid_at,
    );
    if (known) continue;
    const items = JSON.parse(t.items_json) as Array<{ sku: string }>;
    const hasSku = items.some((i) => norm(i.sku) === norm(rules.sku));
    const blind = items.length === 0 && price > 0 && t.amount_cents === price;
    if (!hasSku && !blind) continue;
    const left = t.amount_cents - t.refunded_cents;
    const owed = Math.min(remedyFor(rules, Math.min(price || t.amount_cents, t.amount_cents)), left);
    out.push({
      refKey: t.txn_id,
      txn: t,
      order: null,
      email: t.payer_email,
      name: t.payer_name,
      paidAt: t.paid_at,
      level: hasSku ? 3 : 4,
      matchKind: "paypal-only",
      owed,
      why: hasSku ? "PayPal's record shows the product, but the order export has no such order." : `A PayPal payment of ${usd(t.amount_cents)} with no item details and no matching order. Only the amount and date fit.`,
      state: t.disputed ? "excluded" : left <= 0 ? "excluded" : "needs_confirm",
      excludedReason: t.disputed ? "A dispute is open on this payment" : left <= 0 ? "Already refunded in full" : null,
    });
  }

  tx(() => {
    for (const r of out) {
      run(
        `INSERT INTO affected (id, incident_id, ref_key, txn_id, order_number, email, customer_name, paid_at, level, match_kind, owed_cents, why, state, excluded_reason, confirm_token, status_token)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(incident_id, ref_key) DO UPDATE SET
           level = excluded.level, owed_cents = excluded.owed_cents, why = excluded.why, txn_id = excluded.txn_id,
           state = excluded.state, excluded_reason = excluded.excluded_reason
         WHERE affected.state IN ('ready','needs_confirm','excluded')`,
        newId("af"), incidentId, r.refKey, r.txn?.txn_id ?? null, r.order, r.email, r.name, r.paidAt, r.level, r.matchKind, r.owed, r.why, r.state, r.excludedReason, token(), token(),
      );
    }
    run("UPDATE incident SET status = 'matched' WHERE id = ?", incidentId);
  });

  for (const r of out) {
    if (r.state === "excluded") {
      summary.excluded[r.excludedReason!] = (summary.excluded[r.excludedReason!] ?? 0) + 1;
      continue;
    }
    const k = `level${r.level}`;
    summary.byLevel[k] ??= { count: 0, owedCents: 0 };
    summary.byLevel[k].count++;
    summary.byLevel[k].owedCents += r.owed;
    const bucket = r.state === "ready" ? summary.ready : summary.needsConfirm;
    bucket.count++;
    bucket.owedCents += r.owed;
  }
  logEvent(
    incidentId,
    "rule",
    "match",
    `Checked ${summary.considered} orders of ${rules.sku}: ${summary.ready.count} ready (${usd(summary.ready.owedCents)}), ${summary.needsConfirm.count} need the customer to confirm, ` +
      `${summary.differentBatch} from another batch, ${summary.shippedOutsideWindow} shipped outside the window.`,
  );
  return summary;
}

export interface AffectedRow {
  id: string;
  incident_id: string;
  ref_key: string;
  txn_id: string | null;
  order_number: string | null;
  email: string | null;
  customer_name: string | null;
  paid_at: string | null;
  level: number;
  match_kind: string;
  owed_cents: number;
  why: string;
  state: string;
  excluded_reason: string | null;
  confirm_token: string;
  status_token: string;
}

export const listAffected = (incidentId: string) => all<AffectedRow>("SELECT * FROM affected WHERE incident_id = ? ORDER BY level, paid_at", incidentId);

/** A customer confirms (or rules out) their unit by typing the batch code printed on it. */
export function confirmByCode(confirmToken: string, code: string): { ok: boolean; message: string; row?: AffectedRow } {
  const row = get<AffectedRow>("SELECT * FROM affected WHERE confirm_token = ?", confirmToken);
  if (!row) return { ok: false, message: "This link is not valid." };
  if (row.state !== "needs_confirm") return { ok: row.state !== "declined", message: row.state === "declined" ? "This mixer was already checked and is not from the affected batch." : "Thanks, this one is already confirmed.", row };
  const rules = JSON.parse(get<{ rules_json: string }>("SELECT rules_json FROM incident WHERE id = ?", row.incident_id)!.rules_json) as Rules;
  if (!rules.batch) return { ok: false, message: "This incident does not need a batch code." };
  const match = norm(code) === norm(rules.batch);
  run("UPDATE affected SET state = ? WHERE id = ?", match ? "confirmed" : "declined", row.id);
  logEvent(row.incident_id, "rule", "confirm", `${row.ref_key}: customer entered batch code "${code.slice(0, 20)}", which ${match ? "matches" : "does not match"} ${rules.batch}.`);
  return {
    ok: match,
    message: match ? `Confirmed. Your mixer is from batch ${rules.batch}; your refund of ${usd(row.owed_cents)} is being prepared.` : `That code is not batch ${rules.batch}, so your mixer is not affected. No action is needed.`,
    row: { ...row, state: match ? "confirmed" : "declined" },
  };
}
