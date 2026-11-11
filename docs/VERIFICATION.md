# Make Good: verification report

10 Nov 2026. Everything here was run on this machine (Windows 11, Node 24.19.0). Nothing in this report is a claim about PayPal's real systems: no PayPal call has been made yet.

## 1. What was run

### Automated tests

```bash
npm test
```

Run from `apps/api`. Result of the last run: **82 tests, 82 passed, 0 failed**, in about 80 seconds.

| File | Tests | What it covers |
|---|---|---|
| `test/money.test.ts` | 6 | Exact parsing, PayPal's decimal rules (no decimals for JPY, HUF, TWD), four rounding modes, splits that always add up |
| `test/schema.test.ts` | 4 | Migrations apply once; the database refuses cross-organisation links, bad amounts, and edits to the audit log |
| `test/matching.test.ts` | 28 | The matching engine: packing records, inventory, mixed stock, variants, quantities, returns, replacements, guests, serials, duplicates, overcharges, service outages |
| `test/compensation.test.ts` | 17 | Seven rule types, tax and discount and shipping, limits, earlier refunds, currencies, the 180-day rule, 200 random orders that must add back up |
| `test/execution.test.ts` | 16 | The money path end to end with injected faults: lost replies, 5xx, a stopped worker, duplicate jobs, rate limits, low balance, disputes, pending refunds, approvals, cancellation, payouts |
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

## 2. Outside systems

| System | Reached? | Detail |
|---|---|---|
| PayPal sandbox | **No** | No keys. `make-good/.env` and `apps/api/.env` were checked by variable name only: every PayPal value is empty. |
| PayPal live | No, and refused by default | |
| Exchange rates (Frankfurter, European Central Bank) | **Yes** | `GET https://api.frankfurter.dev/v1/latest` and the date-range form both returned data; USD/EUR 0.89174 for 10 Nov 2026 |
| Claude | No | No key, and no AI feature is built yet |
| A store (WooCommerce, Shopify) | No | No connector built, no store available |
| Email | No | Not built |

## 3. The five demonstration scenarios

| Scenario | State |
|---|---|
| A. Manufacturing recall | Works end to end **on the simulator** (smoke test and `test/api.test.ts`). Not yet on the PayPal sandbox. |
| B. Missing customer (claim) | **Not built.** |
| C. Billing error | Works end to end **on the simulator**: detection, incident, match, refunds. |
| D. Cross-border | Reporting works with live reference rates. Refunds in EUR, GBP and JPY run on the simulator. A real cross-border refund or payout has not been made. |
| E. Failure and recovery | Proven in automated tests on the simulator (lost reply, stopped worker, 5xx). A fault injector for the real sandbox (`FaultInjectingProvider`) is written and **not yet run**. |

## 4. Limits of what the tests prove

1. **The simulator is a model, not PayPal.** It follows PayPal's documented rules for request IDs, refund limits and the 180-day window. Real PayPal may differ in details (error names, timing, how long a request ID is remembered). Every simulator-verified line needs one run on the sandbox.
2. **One database connection.** PGlite has a single connection, so tests of "two workers at once" run one after the other inside it. The locking SQL (`FOR UPDATE SKIP LOCKED`) is standard PostgreSQL, but its behaviour between two real connections has not been observed here.
3. **No load figures.** No performance or throughput number is claimed. The largest set used was 81 orders.
4. **Three failure paths have code but no dedicated test:** expired credentials pausing a batch, a refund amount that differs from the request, and the six-hour limit on automatic repeats.

## 5. Size

| | |
|---|---|
| Source files (`apps/api/src`) | 33 |
| Source lines | about 8,250 |
| Test files and lines | 6 files, about 1,750 lines |
| Schema | 39 tables, about 820 lines of SQL |
| API routes | 57 (53 paths) |
