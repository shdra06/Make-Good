// Money is always an integer count of minor units (cents) plus a currency.
// No floating point touches an amount anywhere in this codebase.
//
// The number of decimal places follows PayPal's rules, because every amount
// here ends up in a PayPal request: PayPal accepts no decimals for HUF, JPY
// and TWD, even though ISO 4217 gives HUF and TWD two.

import { ValidationError } from "./errors.ts";

export type Currency = string;

/** Currencies PayPal can hold and send (PayPal currency codes reference). */
export const PAYPAL_CURRENCIES: ReadonlySet<Currency> = new Set([
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY", "MYR", "MXN",
  "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD", "SEK", "CHF", "THB", "USD",
]);

const NO_DECIMALS: ReadonlySet<Currency> = new Set([
  // PayPal: no decimal amounts
  "HUF", "JPY", "TWD",
  // ISO 4217 zero-decimal currencies, used only for display and FX reporting
  "BIF", "CLP", "DJF", "GNF", "ISK", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMALS: ReadonlySet<Currency> = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function isCurrencyCode(value: unknown): value is Currency {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

export function exponentOf(currency: Currency): 0 | 2 | 3 {
  if (NO_DECIMALS.has(currency)) return 0;
  if (THREE_DECIMALS.has(currency)) return 3;
  return 2;
}

function assertSafe(n: number, what: string): number {
  if (!Number.isSafeInteger(n)) throw new ValidationError(`${what} is not a safe whole number of minor units`);
  return n;
}

/**
 * Parses a decimal string such as "139.00" into minor units, exactly.
 * Rejects more decimal places than the currency allows instead of rounding:
 * an amount we cannot represent is a data problem, not something to hide.
 */
export function toMinor(value: string, currency: Currency): number {
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new ValidationError(`"${value}" is not a decimal amount`);
  const [, sign, whole, fraction = ""] = match;
  const exp = exponentOf(currency);
  const trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length > exp) {
    throw new ValidationError(`"${value}" has more decimal places than ${currency} allows (${exp})`);
  }
  const digits = `${whole}${fraction.padEnd(exp, "0").slice(0, exp)}`;
  const minor = Number(BigInt(digits));
  return assertSafe(sign === "-" ? -minor : minor, `"${value}"`);
}

/** Formats minor units as the plain decimal string PayPal expects, e.g. "139.00" or "1500". */
export function fromMinor(minor: number, currency: Currency): string {
  assertSafe(minor, "amount");
  const exp = exponentOf(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exp + 1, "0");
  const body = exp === 0 ? digits : `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
  return negative ? `-${body}` : body;
}

/** For people: "USD 139.00". Deliberately not locale-dependent, so tests and audit text are stable. */
export function formatMoney(minor: number, currency: Currency): string {
  return `${currency} ${fromMinor(minor, currency)}`;
}

export type Rounding = "half_up" | "half_even" | "down" | "up";

/** Divides two integers and rounds the result to an integer, exactly (BigInt arithmetic). */
export function divideRounded(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) throw new ValidationError("division by zero in a money calculation");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  const r = n % d;
  if (r !== 0n) {
    const twice = r * 2n;
    if (rounding === "up") q += 1n;
    else if (rounding === "half_up" && twice >= d) q += 1n;
    else if (rounding === "half_even" && (twice > d || (twice === d && q % 2n === 1n))) q += 1n;
  }
  return negative ? -q : q;
}

/** amount x (basisPoints / 10000), rounded. 10000 basis points is 100%. */
export function portionBps(minor: number, basisPoints: number, rounding: Rounding = "half_up"): number {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new ValidationError("basis points must be a non-negative whole number");
  }
  return assertSafe(Number(divideRounded(BigInt(minor) * BigInt(basisPoints), 10000n, rounding)), "portion");
}

/** amount x (numerator / denominator), rounded. Used for pro-rata and per-unit shares. */
export function portionRatio(
  minor: number,
  numerator: number,
  denominator: number,
  rounding: Rounding = "half_up",
): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0 || numerator < 0) {
    throw new ValidationError("ratio must be whole numbers with a positive denominator");
  }
  return assertSafe(
    Number(divideRounded(BigInt(minor) * BigInt(numerator), BigInt(denominator), rounding)),
    "portion",
  );
}

/**
 * Splits `total` across `weights` so that the parts add up to `total` exactly.
 * Largest-remainder method: each part is floored, then the leftover minor units
 * go one each to the parts with the largest remainders (ties: earlier part first).
 * With all-zero weights the whole total goes to the first part.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  assertSafe(total, "total");
  if (weights.length === 0) return [];
  if (total < 0) return allocate(-total, weights).map((v) => -v);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new ValidationError("allocation weights must be non-negative whole numbers");
  }
  const weightSum = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (weightSum === 0n) return weights.map((_, i) => (i === 0 ? total : 0));
  const big = BigInt(total);
  const floors = weights.map((w) => (big * BigInt(w)) / weightSum);
  const remainders = weights.map((w) => (big * BigInt(w)) % weightSum);
  let left = big - floors.reduce((a, b) => a + b, 0n);
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    floors[i] = (floors[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return floors.map((v) => Number(v));
}

export function sumMinor(values: readonly number[]): number {
  return assertSafe(values.reduce((a, b) => a + b, 0), "sum");
}

export function clampMinor(value: number, min: number | null, max: number | null): number {
  let out = value;
  if (min !== null && out < min) out = min;
  if (max !== null && out > max) out = max;
  return out;
}
