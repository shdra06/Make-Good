// Orders from a spreadsheet export. One row per order line; rows that share
// an order ID (or, without one, an order number) form one order.
//
// The file is turned into the same `OrderImport` every other source uses, so
// nothing downstream knows it came from a file. Rows that cannot be read are
// reported with their row number. Nothing is guessed: an empty batch code
// stays empty, and matching will then hold that customer for a person.

import { fromMinor, toMinor } from "../../platform/money.ts";
import { OrderImport } from "./ingest.ts";

export const CSV_COLUMNS = [
  "order_id", "order_number", "placed_at", "currency", "customer_email", "customer_name", "payment_method", "paypal_payment_id",
  "sku", "title", "quantity", "unit_price", "order_discount", "shipping", "tax", "total", "shipped_at", "batch_code", "status",
] as const;
const REQUIRED = ["order_number", "placed_at", "currency", "title", "quantity", "unit_price"] as const;

export type CsvError = { row: number; message: string };
export type CsvResult = { orders: OrderImport[]; errors: CsvError[]; rows: number };

/** Splits CSV text into rows of fields. Handles quotes, doubled quotes, and commas or line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const isoDate = (value: string): string | null => {
  const v = value.trim();
  if (v === "") return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function ordersFromCsv(text: string): CsvResult {
  const table = parseCsv(text);
  const errors: CsvError[] = [];
  if (table.length === 0) return { orders: [], errors: [{ row: 1, message: "The file is empty." }], rows: 0 };
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  for (const name of REQUIRED) {
    if (!header.includes(name)) errors.push({ row: 1, message: `The column "${name}" is missing.` });
  }
  if (errors.length > 0) return { orders: [], errors, rows: table.length - 1 };

  type Row = Record<string, string> & { __row: string };
  const groups = new Map<string, Row[]>();
  for (const [i, cells] of table.slice(1).entries()) {
    const r = { __row: String(i + 2) } as Row;
    header.forEach((name, c) => { r[name] = (cells[c] ?? "").trim(); });
    const key = r.order_id || r.order_number || "";
    if (!key) {
      errors.push({ row: i + 2, message: "No order number." });
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const orders: OrderImport[] = [];
  for (const [key, rows] of groups) {
    const first = rows[0]!;
    const at = Number(first.__row);
    const currency = first.currency!.toUpperCase();
    const placedAt = isoDate(first.placed_at!);
    if (!placedAt) {
      errors.push({ row: at, message: `"${first.placed_at}" is not a date.` });
      continue;
    }
    try {
      const minor = (value: string | undefined) => toMinor(value && value !== "" ? value : "0", currency);
      const lines = rows.map((r, i) => {
        const quantity = Number(r.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`row ${r.__row}: quantity "${r.quantity}" is not a whole number above zero`);
        minor(r.unit_price); // checks the amount can be read in this currency
        return { externalId: `l${i + 1}`, sku: r.sku || null, title: r.title!, quantity, unitPrice: r.unit_price! };
      });
      const subtotal = lines.reduce((a, l) => a + minor(l.unitPrice) * l.quantity, 0);
      const discount = minor(first.order_discount);
      const shipping = minor(first.shipping);
      const tax = minor(first.tax);
      const shipped = rows.filter((r) => (r.shipped_at ?? "") !== "" || (r.batch_code ?? "") !== "");
      const byDate = new Map<string, Array<{ lineExternalId: string; quantity: number; batchCode: string | null }>>();
      for (const r of shipped) {
        const when = isoDate(r.shipped_at ?? "") ?? "";
        if ((r.shipped_at ?? "") !== "" && when === "") throw new Error(`row ${r.__row}: "${r.shipped_at}" is not a date`);
        const line = lines[rows.indexOf(r)]!;
        byDate.set(when, [...(byDate.get(when) ?? []), { lineExternalId: line.externalId, quantity: line.quantity, batchCode: r.batch_code || null }]);
      }
      const method = (first.payment_method ?? "").toLowerCase();
      orders.push(OrderImport.parse({
        externalId: `csv-${key}`,
        orderNumber: first.order_number || key,
        placedAt,
        currency,
        customer: { email: first.customer_email || null, name: first.customer_name || null },
        paymentMethod: ["paypal", "card", "cash", "bank", "other"].includes(method) ? method : first.paypal_payment_id ? "paypal" : "unknown",
        paymentReference: first.paypal_payment_id || null,
        discount: fromMinor(discount, currency),
        shipping: fromMinor(shipping, currency),
        tax: fromMinor(tax, currency),
        total: first.total ? first.total : fromMinor(subtotal - discount + shipping + tax, currency),
        ...(first.status ? { status: first.status.toLowerCase() } : {}),
        lines,
        fulfilments: [...byDate.entries()].map(([when, fl], i) => ({ externalId: `f${i + 1}`, shippedAt: when || null, lines: fl })),
        raw: { source: "csv", rows: rows.map((r) => Number(r.__row)) },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ row: at, message: `Order ${first.order_number || key}: ${message.slice(0, 300)}` });
    }
  }
  return { orders, errors, rows: table.length - 1 };
}
