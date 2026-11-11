// Reading an incident document (a supplier's recall notice) into fields a
// person can check: which products, which batches, which dates, what remedy.
//
// Two readers produce the same shape:
//   - pattern rules: plain text matching against the merchant's own catalogue.
//     No AI. Always available.
//   - Gemini: reads the notice as a person would. Needs GEMINI_API_KEY.
//
// Whichever reader ran, its output goes through the same check before anyone
// sees it: every field must quote the exact words of the document it came
// from, and the value must be inside that quote. A field that fails is
// dropped and reported. The reader's output is never trusted on its own.
//
// Nothing here decides who is affected or who is paid. The result is a
// proposal. It becomes the incident's rules only when a person saves it.

import { z } from "zod";
import { normCode, normSku } from "../matching/engine.ts";

/** What a reader returns, before checking. Kept simple so it can be a structured-output schema. */
export const RawExtraction = z.object({
  products: z.array(z.object({
    code: z.string().describe("The product code exactly as written in the document."),
    name: z.string().describe("The product's name as the document gives it, or an empty string."),
    included: z.boolean().describe("true if the document says this product is affected; false if it says it is not."),
    quote: z.string().describe("The exact sentence from the document, copied character for character."),
  })),
  batchCodes: z.array(z.object({
    code: z.string().describe("The batch, lot or serial code exactly as written."),
    affected: z.boolean().describe("true if the document says this batch is affected; false if it says it is not."),
    quote: z.string().describe("The exact sentence from the document, copied character for character."),
  })),
  dates: z.array(z.object({
    meaning: z.enum(["notice_date", "supplier_dispatch_window", "customer_ship_window", "order_window", "other"]),
    from: z.string().describe("First date as YYYY-MM-DD, or an empty string."),
    to: z.string().describe("Last date as YYYY-MM-DD, or an empty string."),
    quote: z.string(),
  })),
  remedy: z.array(z.object({
    kind: z.enum(["full_refund", "partial_refund", "replacement", "repair", "other"]),
    quote: z.string(),
  })).describe("At most one entry. Empty if the document names no remedy."),
  fault: z.array(z.object({ summary: z.string(), quote: z.string() })).describe("At most one entry."),
  notStated: z.array(z.string()).describe("Things a retailer would need that the document does not say, in plain words."),
});
export type RawExtraction = z.infer<typeof RawExtraction>;

type Checked<T> = T & { inCatalogue?: boolean };
export type Extraction = {
  products: Array<Checked<RawExtraction["products"][number]>>;
  batchCodes: RawExtraction["batchCodes"];
  dates: RawExtraction["dates"];
  remedy: RawExtraction["remedy"];
  fault: RawExtraction["fault"];
  notStated: string[];
  /** Fields the reader returned that did not survive the check, with the reason. */
  dropped: Array<{ field: string; value: string; why: string }>;
  warnings: string[];
  /** The rules this would give, for a person to confirm or change. Never applied automatically. */
  proposedScope: { type: "product"; skus: string[]; batchCodes: string[] } | null;
  proposedCompensation: { type: "full_refund" } | null;
};

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const containsCode = (quote: string, code: string): boolean => normCode(quote).includes(normCode(code)) && normCode(code).length > 0;

/**
 * The check every extraction passes through, whoever produced it.
 *   1. The quote must appear in the document word for word (spacing aside).
 *   2. The value must appear inside its own quote.
 * A reader cannot introduce a product or batch the document does not name.
 */
export function checkExtraction(document: string, raw: RawExtraction, catalogueSkus: readonly string[]): Extraction {
  const text = collapse(document);
  const catalogue = new Set(catalogueSkus.map(normSku));
  const dropped: Extraction["dropped"] = [];
  const warnings: string[] = [];
  const quoted = (quote: string) => collapse(quote).length >= 8 && text.includes(collapse(quote));
  const keep = <T extends { quote: string }>(field: string, items: T[], value: (item: T) => string, mustContainValue: boolean): T[] =>
    items.filter((item) => {
      if (!quoted(item.quote)) {
        dropped.push({ field, value: value(item), why: "The words it quotes are not in the document." });
        return false;
      }
      if (mustContainValue && !containsCode(item.quote, value(item))) {
        dropped.push({ field, value: value(item), why: "The value does not appear in the sentence it quotes." });
        return false;
      }
      return true;
    });
  const unique = <T>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((i) => (seen.has(key(i)) ? false : (seen.add(key(i)), true)));
  };

  const products = unique(keep("product", raw.products, (p) => p.code, true), (p) => normSku(p.code)).map((p) => ({
    ...p, inCatalogue: catalogue.has(normSku(p.code)),
  }));
  const batchCodes = unique(keep("batch", raw.batchCodes, (b) => b.code, true), (b) => normCode(b.code));
  const dates = keep("date", raw.dates, (d) => `${d.from} to ${d.to}`, false).filter((d) => {
    const ok = [d.from, d.to].every((x) => x === "" || /^\d{4}-\d{2}-\d{2}$/.test(x));
    if (!ok) dropped.push({ field: "date", value: `${d.from} to ${d.to}`, why: "Not a date in the form YYYY-MM-DD." });
    return ok;
  });
  const remedy = keep("remedy", raw.remedy, (r) => r.kind, false).slice(0, 1);
  const fault = keep("fault", raw.fault, (f) => f.summary, false).slice(0, 1);

  for (const p of products) {
    if (p.included && !p.inCatalogue) warnings.push(`The document names ${p.code} as affected, but no product with that code is in your catalogue.`);
  }
  const included = products.filter((p) => p.included && p.inCatalogue).map((p) => p.code);
  const affected = batchCodes.filter((b) => b.affected).map((b) => b.code);
  if (included.length === 0) warnings.push("No affected product from your catalogue was found in the document. Enter the product codes yourself.");
  if (affected.length === 0) warnings.push("No affected batch code was found. Without one, every unit of the product would be treated as affected.");
  if (dates.some((d) => d.meaning === "supplier_dispatch_window")) {
    warnings.push("The dates in the document are when the supplier shipped to retailers. They are not when your customers' orders shipped, so they are not used to narrow the match.");
  }
  return {
    products, batchCodes, dates, remedy, fault,
    notStated: raw.notStated.map(collapse).filter(Boolean).slice(0, 10),
    dropped, warnings,
    proposedScope: included.length > 0 ? { type: "product", skus: included, batchCodes: affected } : null,
    proposedCompensation: remedy[0]?.kind === "full_refund" ? { type: "full_refund" } : null,
  };
}

// ---------- the pattern-rule reader ----------

const NEGATED = /\bnot\s+(?:affected|included|part\b|covered)|\bunaffected\b|\bexcluded\b|\bdoes\s+not\s+apply\b/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = String.raw`(\d{1,2})\s+(${MONTHS.join("|")})\s+(\d{4})`;

function iso(day: string, month: string, year: string): string {
  return `${year}-${String(MONTHS.indexOf(month.toLowerCase()) + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Sentences, each kept exactly as written so it can be quoted. */
function sentences(document: string): string[] {
  return document
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads a notice with plain text rules. It finds catalogue codes written in
 * the document, codes that follow the words "batch" or "lot", date ranges and
 * the word "refund". It cannot understand a sentence: where a sentence says a
 * code is "not affected" it relies on those words being there.
 */
export function readWithPatternRules(document: string, catalogueSkus: readonly string[]): RawExtraction {
  const out: RawExtraction = { products: [], batchCodes: [], dates: [], remedy: [], fault: [], notStated: [] };
  for (const sentence of sentences(document)) {
    const negated = NEGATED.test(sentence);
    for (const sku of catalogueSkus) {
      const code = sku.trim();
      if (code.length < 3) continue;
      // The code must stand alone: HM-300 is not found inside HM-3000 or HM-300-EU.
      const found = new RegExp(`(?<![A-Za-z0-9-])${escape(code)}(?![A-Za-z0-9-])`, "i").exec(sentence);
      // Reported as the document writes it, not as some order line happened to spell it.
      if (found) out.products.push({ code: found[0], name: "", included: !negated, quote: sentence });
    }
    const batch = /\b(?:batch(?:es)?|lots?)\s*:?\s+(?:codes?\s+|numbers?\s+|no\.?\s+)?((?:[A-Z][A-Z0-9]*-?\d[A-Z0-9-]*)(?:\s*(?:,|and|&)\s*(?:[A-Z][A-Z0-9]*-?\d[A-Z0-9-]*))*)/gi;
    for (const match of sentence.matchAll(batch)) {
      for (const code of match[1]!.split(/\s*(?:,|and|&)\s*/i).filter(Boolean)) {
        out.batchCodes.push({ code, affected: !negated, quote: sentence });
      }
    }
    const range = new RegExp(`between\\s+${DATE}\\s+and\\s+${DATE}`, "i").exec(sentence);
    if (range) {
      out.dates.push({ meaning: "other", from: iso(range[1]!, range[2]!, range[3]!), to: iso(range[4]!, range[5]!, range[6]!), quote: sentence });
    }
    if (out.remedy.length === 0 && /\brefund\b/i.test(sentence)) {
      out.remedy.push({ kind: /\bfull\s+refund\b/i.test(sentence) ? "full_refund" : "partial_refund", quote: sentence });
    }
  }
  out.notStated.push("Pattern rules cannot tell what a date range refers to. Read the quoted sentence.");
  return out;
}
