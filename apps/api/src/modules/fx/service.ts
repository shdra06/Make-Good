// Cross-border financial intelligence: what compensation is owed in which
// currency, and roughly what that is in the merchant's own currency.
//
// What this module is NOT: a way to choose the exchange rate of a refund.
// A refund to an original PayPal payment is made in that payment's currency,
// and PayPal decides any conversion. So this module reports and forecasts.
//
// Rates come from the European Central Bank's daily reference rates, through
// the public Frankfurter API. They are indicative mid-market rates, published
// once per working day. They are NOT the rate PayPal applies to a transaction,
// and every figure built on them is labelled as an estimate.

import type { Clock } from "../../platform/clock.ts";
import { DAY } from "../../platform/clock.ts";
import type { Db } from "../../platform/db/db.ts";
import { AppError, ValidationError } from "../../platform/errors.ts";
import { divideRounded, exponentOf, isCurrencyCode, PAYPAL_CURRENCIES, portionBps } from "../../platform/money.ts";

export const FX_PROVIDER = "ecb-frankfurter";
const SCALE = 10n ** 12n;

export type FxDeps = { db: Db; clock: Clock; apiUrl: string; fetchImpl?: typeof fetch };

export type Rate = { base: string; quote: string; rate: string; date: string; provider: string };

/** "0.92135" -> 921350000000n (scaled by 10^12), exactly. */
function scaled(rate: string): bigint {
  const [whole = "0", fraction = ""] = rate.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, "0").slice(0, 12));
}

/** Converts minor units of one currency to minor units of another at a given rate. Integer arithmetic only. */
export function convertMinor(minor: number, from: string, to: string, rate: string): number {
  const exponentShift = exponentOf(to) - exponentOf(from);
  let numerator = BigInt(minor) * scaled(rate);
  let denominator = SCALE;
  if (exponentShift > 0) numerator *= 10n ** BigInt(exponentShift);
  if (exponentShift < 0) denominator *= 10n ** BigInt(-exponentShift);
  return Number(divideRounded(numerator, denominator, "half_up"));
}

export class FxService {
  readonly #deps: FxDeps;
  constructor(deps: FxDeps) {
    this.#deps = deps;
  }

  async #get(path: string): Promise<Record<string, unknown>> {
    const fetcher = this.#deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetcher(`${this.#deps.apiUrl}${path}`, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new AppError("FX_SOURCE_ERROR", 502, `The exchange-rate source answered ${res.status}.`);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("FX_SOURCE_UNAVAILABLE", 502, "The exchange-rate source could not be reached. Stored rates are still shown.");
    } finally {
      clearTimeout(timer);
    }
  }

  async #store(base: string, date: string, rates: Record<string, unknown>): Promise<number> {
    let stored = 0;
    const now = this.#deps.clock.now().toISOString();
    await this.#deps.db.tx(async (tx) => {
      for (const [quote, value] of Object.entries(rates)) {
        if (!isCurrencyCode(quote) || typeof value !== "number" || !(value > 0)) continue;
        await tx.query(
          `insert into fx_rates (provider, rate_date, base, quote, rate, fetched_at) values ($1, $2, $3, $4, $5, $6)
           on conflict (provider, rate_date, base, quote) do update set rate = excluded.rate, fetched_at = excluded.fetched_at`,
          [FX_PROVIDER, date, base, quote, String(value), now],
        );
        stored++;
      }
    });
    return stored;
  }

  /** Fetches the latest published rates for a base currency and stores them. */
  async refresh(base: string): Promise<{ date: string; stored: number }> {
    if (!isCurrencyCode(base)) throw new ValidationError("The base currency must be a three-letter code.");
    const body = await this.#get(`/latest?base=${base}`);
    const date = String(body.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof body.rates !== "object" || body.rates === null) {
      throw new AppError("FX_SOURCE_ERROR", 502, "The exchange-rate source sent a reply we could not read.");
    }
    return { date, stored: await this.#store(base, date, body.rates as Record<string, unknown>) };
  }

  /** Fetches and stores a daily series, for the history chart. */
  async refreshHistory(base: string, quote: string, days: number): Promise<number> {
    if (!isCurrencyCode(base) || !isCurrencyCode(quote)) throw new ValidationError("Currencies must be three-letter codes.");
    const to = this.#deps.clock.now();
    const from = new Date(to.getTime() - Math.min(Math.max(days, 1), 366) * DAY);
    const body = await this.#get(`/${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}?base=${base}&symbols=${quote}`);
    let stored = 0;
    for (const [date, rates] of Object.entries((body.rates ?? {}) as Record<string, Record<string, unknown>>)) {
      stored += await this.#store(base, date, rates);
    }
    return stored;
  }

  /** The most recent stored rate. Refreshes first if the newest one we hold is more than a day old. */
  async latest(base: string, quote: string): Promise<Rate | null> {
    if (base === quote) return { base, quote, rate: "1", date: this.#deps.clock.now().toISOString().slice(0, 10), provider: "identity" };
    const read = async () =>
      (await this.#deps.db.query<{ rate: string; rate_date: string | Date; fetched_at: Date }>(
        `select rate::text as rate, rate_date, fetched_at from fx_rates
          where provider = $1 and base = $2 and quote = $3 order by rate_date desc limit 1`,
        [FX_PROVIDER, base, quote],
      ))[0];
    let row = await read();
    const stale = !row || this.#deps.clock.now().getTime() - new Date(row.fetched_at).getTime() > DAY;
    if (stale) {
      try {
        await this.refresh(base);
        row = await read();
      } catch (err) {
        if (!row) throw err; // nothing stored and the source is down
      }
    }
    if (!row) return null;
    const date = row.rate_date instanceof Date ? row.rate_date.toISOString().slice(0, 10) : String(row.rate_date).slice(0, 10);
    return { base, quote, rate: row.rate, date, provider: FX_PROVIDER };
  }

  async history(base: string, quote: string, days: number): Promise<Array<{ date: string; rate: string }>> {
    const since = new Date(this.#deps.clock.now().getTime() - days * DAY).toISOString().slice(0, 10);
    const rows = await this.#deps.db.query<{ rate_date: string | Date; rate: string }>(
      `select rate_date, rate::text as rate from fx_rates
        where provider = $1 and base = $2 and quote = $3 and rate_date >= $4 order by rate_date`,
      [FX_PROVIDER, base, quote, since],
    );
    return rows.map((r) => ({
      date: r.rate_date instanceof Date ? r.rate_date.toISOString().slice(0, 10) : String(r.rate_date).slice(0, 10),
      rate: r.rate,
    }));
  }

  /**
   * What is owed and not yet paid, by currency, with an indicative value in
   * the organisation's own currency.
   */
  async exposure(orgId: string, orgCurrency: string, assumedSpreadBps: number | null) {
    const rows = await this.#deps.db.query<{ currency: string; status: string; route: string; customers: number; amount_minor: number }>(
      `select trim(k.currency) as currency, c.status, k.route, count(*)::int as customers, sum(k.payable_minor)::bigint as amount_minor
         from candidates c
         join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
         join incidents i on i.org_id = c.org_id and i.id = c.incident_id
        where c.org_id = $1 and i.status = 'active' and c.status in ('proposed', 'confirmed') and k.payable_minor > 0
          and not exists (select 1 from payment_operations op where op.org_id = c.org_id and op.candidate_id = c.id and op.state = 'succeeded')
        group by 1, 2, 3`,
      [orgId],
    );
    const countries = await this.#deps.db.query<{ country: string | null; currency: string; customers: number; amount_minor: number }>(
      `select p.payer_country as country, trim(k.currency) as currency, count(*)::int as customers, sum(k.payable_minor)::bigint as amount_minor
         from candidates c
         join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
         join incidents i on i.org_id = c.org_id and i.id = c.incident_id
         left join payment_transactions p on p.org_id = c.org_id and p.id = c.payment_transaction_id
        where c.org_id = $1 and i.status = 'active' and c.status in ('proposed', 'confirmed') and k.payable_minor > 0
        group by 1, 2 order by 4 desc`,
      [orgId],
    );
    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    const byCurrency = [];
    let totalInOrgCurrency = 0;
    let complete = true;
    for (const currency of currencies) {
      const mine = rows.filter((r) => r.currency === currency);
      const sum = (pred: (r: (typeof rows)[number]) => boolean) => mine.filter(pred).reduce((a, r) => a + r.amount_minor, 0);
      const total = sum(() => true);
      let rate: Rate | null = null;
      let rateError: string | null = null;
      try {
        rate = await this.latest(currency, orgCurrency);
      } catch (err) {
        rateError = err instanceof Error ? err.message : "No rate available.";
      }
      const converted = rate ? convertMinor(total, currency, orgCurrency, rate.rate) : null;
      if (converted === null) complete = false;
      else totalInOrgCurrency += converted;
      const foreign = currency !== orgCurrency;
      byCurrency.push({
        currency,
        customers: mine.reduce((a, r) => a + r.customers, 0),
        owedMinor: total,
        confirmedMinor: sum((r) => r.status === "confirmed"),
        awaitingConfirmationMinor: sum((r) => r.status === "proposed"),
        byRoute: Object.fromEntries(["refund_original", "payout", "manual"].map((route) => [route, sum((r) => r.route === route)])),
        supportedByPayPal: PAYPAL_CURRENCIES.has(currency),
        indicativeRate: rate && foreign ? { rate: rate.rate, date: rate.date, source: "European Central Bank reference rate (Frankfurter). Not PayPal's rate." } : null,
        rateError,
        estimatedInOrgCurrencyMinor: converted,
        // Shown only when the merchant has entered their own assumption. It is not a PayPal quote.
        estimatedConversionCostMinor: foreign && converted !== null && assumedSpreadBps !== null ? portionBps(converted, assumedSpreadBps) : null,
      });
    }
    return {
      orgCurrency,
      asOf: this.#deps.clock.now().toISOString(),
      byCurrency,
      byCountry: countries,
      estimatedTotalInOrgCurrencyMinor: complete ? totalInOrgCurrency : null,
      assumedSpreadBps,
      notes: [
        "Refunds to an original PayPal payment are made in that payment's currency. Make Good cannot choose the rate.",
        "Rates shown are daily reference rates, not the rate PayPal will apply. Treat converted figures as estimates.",
        assumedSpreadBps === null
          ? "No conversion-cost estimate is shown. Enter your own assumed spread in settings to see one."
          : `The conversion cost uses your own assumption of ${assumedSpreadBps / 100}%. It is not a PayPal quote.`,
      ],
    };
  }
}
