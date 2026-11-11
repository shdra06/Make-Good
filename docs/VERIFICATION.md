# Make Good: verification report

Updated 11 Nov 2026. Everything here was run on this machine (Windows 11, Node 24.19.0). Section 2 is the only part that involves PayPal's real systems, and it is the sandbox, never live money.

## 1. What was run

### Automated tests

```bash
npm test
```

Run from `apps/api`. Result of the last run (11 Nov): **83 tests, 83 passed, 0 failed**, in about 75 seconds.

| File | Tests | What it covers |
|---|---|---|
| `test/money.test.ts` | 6 | Exact parsing, PayPal's decimal rules (no decimals for JPY, HUF, TWD), four rounding modes, splits that always add up |
| `test/schema.test.ts` | 4 | Migrations apply once; the database refuses cross-organisation links, bad amounts, and edits to the audit log |
| `test/matching.test.ts` | 28 | The matching engine: packing records, inventory, mixed stock, variants, quantities, returns, replacements, guests, serials, duplicates, overcharges, service outages |
| `test/compensation.test.ts` | 17 | Seven rule types, tax and discount and shipping, limits, earlier refunds, currencies, the 180-day rule, 200 random orders that must add back up |
| `test/execution.test.ts` | 17 | The money path end to end with injected faults: lost replies, 5xx, a stopped worker, duplicate jobs, rate limits, low balance, disputes, pending refunds, approvals, cancellation, payouts, and fetching a payment by its ID |
| `test/api.test.ts` | 11 | Sign-in, rate limit, tenant isolation on all 48 organisation routes, roles, cross-site requests, a recall through the API, monitoring, currency exposure, secret handling, webhooks, the API description |

The database in these tests is PGlite: PostgreSQL itself, compiled to run in-process, in memory. The SQL and the migrations are the same ones production would use.

### Type check

```bash
npm run typecheck
```

Passed with no errors. Settings are strict (`strict`, `noUncheckedIndexedAccess`).

### A real server, over HTTP

```bash
npm start
```

```bash
npm run smoke
```

The smoke script registers a user, creates an organisation, connects the simulator, loads sample data and runs three scenarios against the running server. Output of the second run:

```
  ok   server is up  (database: pglite)
  ok   register and sign in
  ok   create organisation
  ok   connect the PayPal simulator  (no real PayPal calls in this run)
  ok   load sample data  (81 orders, 83 payments)

Scenario A: manufacturing recall
  ok   match affected customers  ({"exact_unit":20,"likely":6,"strong_multi_source":5,"product_only":1})
  ok   dry run moves no money  (19 payable: 15 x USD 1062.00, 2 x EUR 118.00, 1 x GBP 59.00, 1 x JPY 8850; ...)
  ok   approve the batch
  ok   start paying  (19 operations queued)
  ok   worker finishes the batch  (19 of 19 succeeded)

Scenario C: billing error found by monitoring
  ok   detect double charges  (3 found; 3 new)
  ok   refund the duplicates  (3 proven duplicates, 3 refunded)

Scenario D: currency exposure (live reference rates)
  ok   find overcharged orders  (4 customers)
  ok   exposure by currency
  ok   live reference rates  (USD/EUR 0.89174 on 2026-11-10)

Records
  ok   audit chain intact  (66 rows)
  ok   dashboard reflects the work  (22 payments succeeded)
  ok   OpenAPI description  (53 paths)

All checks passed.
```

The first of the two runs failed one check: the exchange-rate source could not be reached. The server reported that plainly and kept working, and the same call succeeded seconds later. This machine's connection dropped several downloads during the session, so this is most likely the network, but it was seen once and is recorded here.

## 2. The real PayPal sandbox (11 Nov 2026)

```bash
npm run sandbox
```

Run twice, with the keys in `make-good/.env`. Both runs gave the same results. No simulator is involved: the script creates real sandbox payments by test card, runs the product on them, and then asks PayPal directly what happened.

| Step | Result |
|---|---|
| PayPal accepts the keys | 28 permissions. Refunds, payouts, disputes and webhooks granted. Transaction Search and partner referrals not granted. |
| Create 4 sandbox payments | Done by test card through the Orders API |
| Connect an organisation to PayPal | Connected, environment `sandbox` |
| Fetch the 3 payments by ID and link them to imported orders | 3 of 3 |
| Match, dry run | 3 customers, 118.00 USD (half of each payment), nothing sent |
| Approve and run the batch through the worker | Batch completed, 3 of 3 refunds succeeded |
| One reply discarded on purpose after PayPal had acted | The operation was marked `unknown`, not failed |
| Ask PayPal again with the same request ID | PayPal returned the same refund (second run: `4EL59195VN244433R` both times) |
| Ask PayPal for each refund | `COMPLETED`, with the amount we asked for |
| Refund whatever was left on each payment | Exactly half was left each time, so each had been refunded once, not twice |
| Bad refunds | Refused with the error names listed in `docs/PAYPAL.md` section 0 |
| Disputes list | Answers (no disputes) |
| Payout of 1.00 USD to an address with no account | Created; `UNCLAIMED`; a repeat was refused and named the original |
| Transaction Search | **Refused: `403 NOT_AUTHORIZED`.** This app lacks the permission. |
| Cancel the test payout (clean-up only) | **PayPal answered `500` on every try.** One 1.00 USD sandbox payout is left unclaimed. |

PayPal IDs from the second run, which can be looked up in the sandbox dashboard:

| Payment (capture) | Our refund | Calls we made |
|---|---|---|
| `0M663819ER338205M` | `9FG16858J9078684G`, 29.50 USD | 1 |
| `8SB69345EG883261P` | `9L863912DK582840C`, 29.50 USD | 1 |
| `43E07198HV725294K` | `4EL59195VN244433R`, 59.00 USD | 3 (the first reply was discarded; one refund resulted) |

After the check, the script refunded the rest of each payment so that the remainder could be measured. Those payments are therefore fully refunded now.

What this run does not show: the orders were created through the import format, not pulled from a real store; the payments were card payments, not PayPal-wallet payments; and nothing here used Transaction Search.

## 3. Other outside systems

| System | Reached? | Detail |
|---|---|---|
| PayPal sandbox | **Yes** | See section 2 |
| PayPal live | No, and refused by default | |
| Exchange rates (Frankfurter, European Central Bank) | **Yes** | `GET https://api.frankfurter.dev/v1/latest` and the date-range form both returned data; USD/EUR 0.89174 for 10 Nov 2026 |
| Claude | No | No key, and no AI feature is built yet |
| A store (WooCommerce, Shopify) | No | No connector built, no store available |
| Email | No | Not built |

## 4. The five demonstration scenarios

| Scenario | State |
|---|---|
| A. Manufacturing recall | Works end to end on the simulator (81 sample orders) **and on the PayPal sandbox** (3 real payments, real refunds). No screens yet. |
| B. Missing customer (claim) | **Not built.** |
| C. Billing error | Works end to end **on the simulator**: detection, incident, match, refunds. On a real account, detection needs Transaction Search, which this app does not have yet. |
| D. Cross-border | Reporting works with live reference rates. Refunds in EUR, GBP and JPY run on the simulator. A real cross-border refund or payout has not been made. |
| E. Failure and recovery | **Run on the PayPal sandbox** for a lost reply: one refund, found again by request ID. A stopped worker, 5xx answers and rate limits are proven on the simulator only. |

## 5. Limits of what the tests prove

1. **The simulator is a model, not PayPal.** It follows PayPal's rules for request IDs, refund limits and the 180-day window. The sandbox run confirmed the request-ID rule and four refusals, and corrected one error name. Pending refunds, low balance, disputes and old payments have still only run on the simulator.
2. **One database connection.** PGlite has a single connection, so tests of "two workers at once" run one after the other inside it. The locking SQL (`FOR UPDATE SKIP LOCKED`) is standard PostgreSQL, but its behaviour between two real connections has not been observed here.
3. **No load figures.** No performance or throughput number is claimed. The largest set used was 81 orders.
4. **Three failure paths have code but no dedicated test:** expired credentials pausing a batch, a refund amount that differs from the request, and the six-hour limit on automatic repeats.

## 6. Size

| | |
|---|---|
| Source files (`apps/api/src`) | 33 |
| Source lines | about 8,340 |
| Test files and lines | 6 files, about 1,770 lines |
| Check scripts (`smoke`, `sandbox`) | about 600 lines |
| Schema | 39 tables, about 820 lines of SQL |
| API routes | 58 (54 paths) |
