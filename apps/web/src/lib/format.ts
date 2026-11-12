import { formatMoney } from "@makegood/shared";
import type { MoneyMap } from "./types";

export const money = (minor: number | null | undefined, currency = "USD") =>
  minor === null || minor === undefined ? "–" : formatMoney(Number(minor), currency);

/** "$59.00 + €20.00", or "–" when empty. */
export function moneyMap(byCurrency: MoneyMap | null | undefined): string {
  const parts = Object.entries(byCurrency ?? {})
    .filter(([, v]) => v)
    .map(([c, v]) => money(v, c));
  return parts.length ? parts.join(" + ") : "–";
}

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–";
export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–";
export const short = (s: string | null | undefined, n = 10) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? "–"));
export const words = (s: string) => s.replace(/[._]/g, " ");
