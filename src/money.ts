// All money is integer cents inside Make Good. Decimal strings exist only at the PayPal boundary.

export type Cents = number;

export const toCents = (value: string | number): Cents => {
  const s = typeof value === "number" ? value.toFixed(2) : String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Not a money amount: ${value}`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
};

export const fmt = (c: Cents): string => {
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

export const usd = (c: Cents): string => `$${fmt(c)}`;

/** Share of `part` in `whole`, applied to `amount`, rounded half-up to the cent. */
export const share = (amount: Cents, part: Cents, whole: Cents): Cents =>
  whole === 0 ? 0 : Math.floor((amount * part) / whole + 0.5);

export const pct = (c: Cents, percent: number): Cents => Math.floor((c * percent) / 100 + 0.5);
