// Step 1: bring the merchant's PayPal payments and the shop's order export into one database.
import { all, get, logEvent, run, tx } from "../db.ts";
import { toCents } from "../money.ts";
import { paypal, type TransactionDetail } from "../paypal/index.ts";

const WINDOW_MS = 31 * 86400_000; // PayPal allows at most 31 days per Transaction Search request

export interface BackfillResult {
  windows: number;
  payments: number;
  refundsSeen: number;
  disputed: number;
  from: string;
  to: string;
}

/** Pull payments between two dates, 31 days at a time, and note refunds and open disputes. */
export async function backfill(fromIso: string, toIso: string): Promise<BackfillResult> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const rows: TransactionDetail[] = [];
  let windows = 0;
  for (let start = from; start < to; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, to);
    windows++;
    for (let page = 1; ; page++) {
      const res = await paypal.listTransactions(new Date(start).toISOString(), new Date(end).toISOString(), page);
      rows.push(...(res.transaction_details ?? []));
      if (page >= (res.total_pages ?? 1)) break;
    }
  }

  const payments = rows.filter((r) => toCents(r.transaction_info.transaction_amount.value) > 0 && !(r.transaction_info.transaction_event_code ?? "").startsWith("T11"));
  const refunds = rows.filter((r) => (r.transaction_info.transaction_event_code ?? "").startsWith("T11") && r.transaction_info.paypal_reference_id);
  const refundedBy = new Map<string, number>();
  for (const r of refunds) {
    const ref = r.transaction_info.paypal_reference_id!;
    refundedBy.set(ref, (refundedBy.get(ref) ?? 0) + Math.abs(toCents(r.transaction_info.transaction_amount.value)));
  }
  const disputes = await paypal.listOpenDisputes();
  const disputedIds = new Set(disputes.flatMap((d) => d.transaction_ids));

  tx(() => {
    for (const p of payments) {
      const info = p.transaction_info;
      const name = p.payer_info?.payer_name;
      const items = (p.cart_info?.item_details ?? []).map((it) => ({
        sku: it.item_code ?? "",
        name: it.item_name ?? "",
        qty: Number(it.item_quantity ?? 1),
        unitCents: it.item_unit_price ? toCents(it.item_unit_price.value) : null,
      }));
      run(
        `INSERT INTO paypal_txn (txn_id, payer_email, payer_name, amount_cents, currency, paid_at, invoice_id, items_json, refunded_cents, disputed, source)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'search')
         ON CONFLICT(txn_id) DO UPDATE SET refunded_cents = excluded.refunded_cents, disputed = excluded.disputed, items_json = excluded.items_json`,
        info.transaction_id,
        (p.payer_info?.email_address ?? "").toLowerCase(),
        name?.alternate_full_name ?? [name?.given_name, name?.surname].filter(Boolean).join(" "),
        toCents(info.transaction_amount.value),
        info.transaction_amount.currency_code,
        info.transaction_initiation_date,
        info.invoice_id ?? null,
        JSON.stringify(items),
        refundedBy.get(info.transaction_id) ?? 0,
        disputedIds.has(info.transaction_id) ? 1 : 0,
      );
    }
  });
  const out = { windows, payments: payments.length, refundsSeen: refunds.length, disputed: disputedIds.size, from: fromIso, to: toIso };
  logEvent(null, "paypal", "backfill", `Read ${out.payments} payments from PayPal in ${windows} requests of up to 31 days; ${out.refundsSeen} earlier refunds and ${out.disputed} open disputes noted.`);
  return out;
}

// ------------------------------------------------------------------ order export (CSV)

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const REQUIRED = ["order_number", "paid_at", "sku", "qty", "unit_price", "order_total"];

export interface ImportResult {
  lines: number;
  orders: number;
  skipped: Array<{ row: number; reason: string }>;
}

/** Import the shop's order export. One row per order line; see `ordersToCsv` for the columns. */
export function importOrdersCsv(csv: string): ImportResult {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("The order file is empty.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`The order file is missing these columns: ${missing.join(", ")}.`);
  const col = (r: string[], name: string) => (head.includes(name) ? (r[head.indexOf(name)] ?? "").trim() : "");
  const skipped: ImportResult["skipped"] = [];
  let lines = 0;
  tx(() => {
    rows.slice(1).forEach((r, i) => {
      try {
        const paidAt = new Date(col(r, "paid_at"));
        if (Number.isNaN(paidAt.getTime())) throw new Error("paid_at is not a date");
        const shipped = col(r, "shipped_at");
        run(
          `INSERT INTO order_line (order_number, email, customer_name, paid_at, sku, item_name, qty, unit_cents, line_discount_cents, order_total_cents, shipped_at, batch_code, paid_via)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(order_number, sku) DO UPDATE SET shipped_at = excluded.shipped_at, batch_code = excluded.batch_code, qty = excluded.qty`,
          col(r, "order_number"),
          col(r, "email").toLowerCase() || null,
          col(r, "customer_name") || null,
          paidAt.toISOString(),
          col(r, "sku"),
          col(r, "item_name") || null,
          Number(col(r, "qty")),
          toCents(col(r, "unit_price")),
          toCents(col(r, "line_discount") || "0"),
          toCents(col(r, "order_total")),
          shipped ? new Date(shipped).toISOString() : null,
          col(r, "batch_code") || null,
          col(r, "paid_via") || "paypal",
        );
        lines++;
      } catch (err) {
        skipped.push({ row: i + 2, reason: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  const orders = get<{ n: number }>("SELECT COUNT(DISTINCT order_number) AS n FROM order_line")!.n;
  logEvent(null, "person", "orders-import", `Imported ${lines} order lines (${orders} orders); ${skipped.length} rows skipped.`);
  return { lines, orders, skipped };
}

export const ledgerStats = () => ({
  payments: get<{ n: number }>("SELECT COUNT(*) AS n FROM paypal_txn")!.n,
  orders: get<{ n: number }>("SELECT COUNT(DISTINCT order_number) AS n FROM order_line")!.n,
  orderLines: get<{ n: number }>("SELECT COUNT(*) AS n FROM order_line")!.n,
  skus: all<{ sku: string; item_name: string; n: number }>("SELECT sku, MAX(item_name) AS item_name, COUNT(*) AS n FROM order_line GROUP BY sku ORDER BY n DESC"),
});
