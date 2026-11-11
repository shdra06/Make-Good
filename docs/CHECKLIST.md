# Make Good: implementation checklist

Last updated 11 Nov 2026. A line is marked **Verified** only after it ran and passed. The evidence column says what was run.

| Mark | Meaning |
|---|---|
| **Verified** | Built, and a test or a live run passed |
| **Built, not verified** | Code exists and type-checks, but the outside system it talks to was never reached |
| **Not built** | No code yet |
| **Blocked** | Cannot go further without something only you can provide |

How to re-run the evidence, from `apps/api`:

```bash
npm test
```

```bash
npm run smoke
```

```bash
npm run sandbox
```

`npm test` runs the automated tests against a real PostgreSQL engine running in-process (PGlite). `npm run smoke` drives a running server over HTTP. Neither touches PayPal: they use the built-in simulator. `npm run sandbox` is the one that talks to PayPal's real sandbox, using the keys in `make-good/.env`.

## Stage 1. Architecture and foundation

| Item | State | Evidence |
|---|---|---|
| Architecture chosen and recorded | Verified | `docs/ARCHITECTURE.md` |
| Database schema, 39 tables, multi-tenant, with constraints | Verified | `test/schema.test.ts` (4 tests) |
| Migrations with checksums, safe to re-run | Verified | `test/schema.test.ts` |
| Cross-organisation references refused by the database itself | Verified | `test/schema.test.ts` |
| Money as integer minor units, exact parsing, rounding, allocation | Verified | `test/money.test.ts` (6 tests) |
| Accounts, sessions (hashed tokens), password hashing (scrypt) | Verified | `test/api.test.ts` |
| Organisations, six roles, permission matrix | Verified | `test/api.test.ts` "roles" |
| Tenant isolation on every organisation route (all 48, found from the API description so new routes are covered automatically) | Verified | `test/api.test.ts` "tenant isolation" |
| Append-only audit log with hash chain | Verified | `test/schema.test.ts`, `test/execution.test.ts` |
| Secrets encrypted at rest (AES-256-GCM), never returned or logged | Verified | `test/api.test.ts` "credentials" |
| Configuration checked at start, live PayPal off by default | Verified | `test/api.test.ts` (live refused with 403) |
| OpenAPI 3.1 description generated from the route definitions | Verified | `GET /api/openapi.json`, 53 paths |

## Stage 2. Core PayPal integration

"Verified on the sandbox" means the call was made to PayPal's real sandbox on 11 Nov 2026 with `npm run sandbox` (two full runs), and PayPal's own answer was checked.

| Item | State | Evidence |
|---|---|---|
| Sign in to PayPal and read which permissions the app has | **Verified on the sandbox** | 28 permissions returned; refunds, payouts, disputes and webhooks granted |
| Fetch a payment by its ID | **Verified on the sandbox** | 3 of 3 found and linked to orders, both runs |
| Partial and full refunds | **Verified on the sandbox** | 6 product refunds across two runs, each `COMPLETED` at PayPal |
| Look up a refund | **Verified on the sandbox** | Amount and status matched what we asked for |
| A repeated request ID returns the same refund and moves no money | **Verified on the sandbox** | Same refund ID came back, both runs |
| Recovery when PayPal acted but the reply was lost | **Verified on the sandbox** | Reply discarded on purpose; operation went to `unknown`; PayPal returned the first refund; exactly one refund existed |
| PayPal's refusals: too much, already refunded, wrong currency, too many decimals, unknown ID | **Verified on the sandbox** | Real error names recorded in `docs/PAYPAL.md` |
| Disputes list | **Verified on the sandbox** | The call answers. No dispute existed, so reading one is untested. |
| Payouts: create, read back, and a repeat is refused with a pointer to the original | **Verified on the sandbox** (direct calls) | Payout `UNCLAIMED` as expected for an address with no account. The worker's payout path has run on the simulator only. |
| Transaction Search sync | **Blocked** | PayPal answered `403 NOT_AUTHORIZED`: this app does not have the Transaction Search permission. Works on the simulator. |
| Refund totals recomputed from PayPal's refund rows | Verified on the simulator | Depends on Transaction Search |
| Pending refunds, low balance, a dispute on the payment | Verified on the simulator only | Hard to cause on demand in the sandbox |
| Webhooks: stored once, signature checked, unverified events never acted on | Verified on the simulator | `test/api.test.ts` "webhooks" |
| Webhook signature check against real PayPal | Built, not verified | Needs a registered webhook and a public address |
| Partner onboarding (PayPal's consent screen) | Built, not verified | PayPal's permission list confirms this app is not a partner. **Needs PayPal partner approval.** |

## Stage 3. Merchant and commerce integration

| Item | State | Evidence |
|---|---|---|
| One import format for every store, with validation and warnings | Verified | `test/execution.test.ts` (all orders go through it) |
| Order import API (up to 500 per call), stock batch import API | Verified | Smoke test, `test/api.test.ts` |
| Order to payment linking: exact (store reference, invoice ID, custom ID) and heuristic (flagged) | Verified | `test/matching.test.ts`, `test/execution.test.ts` |
| WooCommerce connector | Not built | Needs a test store |
| Shopify connector | Not built | Needs a Shopify partner account and a development store |
| CSV upload | Not built | |
| Orders linked to real sandbox payments by PayPal's payment ID | **Verified on the sandbox** | The orders came through the import format, not from a store |
| Fetching a payment by ID when Transaction Search is behind or not permitted | Verified on the simulator and the sandbox | `test/execution.test.ts`, `npm run sandbox` |
| A real store (WooCommerce or Shopify) as the source of those orders | **Blocked** | Needs a test store |

## Stage 4. Incidents and matching

| Item | State | Evidence |
|---|---|---|
| Incidents with versioned, never-edited rules | Verified | `test/api.test.ts` |
| Matching engine: five evidence levels, evidence and missing-information lists, recommended action | Verified | `test/matching.test.ts` (28 tests) |
| Batch by packing record, by inventory dates, mixed stock, ship window only, no data | Verified | `test/matching.test.ts` |
| Variants, multi-quantity lines, partial and full returns, replacements, guest checkout, non-PayPal orders | Verified | `test/matching.test.ts` |
| Serial numbers | Verified | `test/matching.test.ts` |
| Duplicate charges, overcharges, service outages | Verified | `test/matching.test.ts` |
| Bundles | Partly | Compensation sends an unpriced bundle component to a person (tested). Bundle expansion in matching is not built. |
| Marketplace and point-of-sale orders | Not built | They can be imported through the same format; no connector exists |
| Re-running a match keeps a person's earlier decision | Verified | `test/execution.test.ts` (re-match after payment) |

## Stage 5. Compensation and execution

| Item | State | Evidence |
|---|---|---|
| Seven rule types with tax, discount and shipping spread across lines | Verified | `test/compensation.test.ts` (17 tests) |
| Lines always add back to the order total (200 random orders) | Verified | `test/compensation.test.ts` |
| Earlier refunds, payment balance ceiling, minimum and maximum | Verified | `test/compensation.test.ts` |
| Route choice: refund, payout, or a person. No currency conversion on refunds. | Verified | `test/compensation.test.ts` |
| Step-by-step working stored with every amount | Verified | `test/api.test.ts` |
| Dry run (preview) that writes nothing and calls nothing | Verified | `test/execution.test.ts` |
| Approval: roles, second person, approval bound to the exact contents | Verified | `test/execution.test.ts` "approval rules" |
| Durable job queue in PostgreSQL, at-least-once, with leases | Verified | `test/execution.test.ts` |
| Lost reply after PayPal acted: resolved, one refund | Verified on the simulator **and on the sandbox** | `test/execution.test.ts`, `npm run sandbox` |
| Request never arrived: retried, one refund | Verified on the simulator | `test/execution.test.ts` |
| Worker stops mid-call: found by the sweep, resolved, one refund | Verified on the simulator | `test/execution.test.ts` |
| Same job twice, two workers at once | Verified in one process | `test/execution.test.ts`. **Not yet verified with two separate database connections**, see below |
| Rate limit, low balance (batch pauses and resumes), dispute, already refunded | Verified on the simulator | `test/execution.test.ts` |
| Pending refunds followed to completion or failure | Verified on the simulator | `test/execution.test.ts` |
| Cancelled batch with an unknown outcome: no repeat, a person is told, PayPal's records settle it | Verified on the simulator | `test/execution.test.ts` |
| Payouts for payments older than 180 days | Verified on the simulator | `test/execution.test.ts` |
| One live refund per payment, one payment per customer: enforced by database indexes | Verified | `test/execution.test.ts` |

## Stage 6. Claims and AI

| Item | State | Evidence |
|---|---|---|
| Tables for claims, evidence and claim events | Verified | Part of the schema |
| Customer claim portal, evidence upload, review, appeal | **Not built** | |
| AI reading of receipts and labels | **Not built** | Will need a Claude key to verify |
| Email notices | **Not built** | Table exists; no transport code |

## Stage 7. Monitoring and financial intelligence

| Item | State | Evidence |
|---|---|---|
| Seven detectors, each stating what it needs and what it cannot see | Verified | `test/api.test.ts` "monitoring", smoke test |
| One click from double-charge findings to an incident with rules filled in | Verified | `test/api.test.ts` |
| Currency exposure with indicative rates and stated assumptions | Verified | `test/api.test.ts` "currency exposure" |
| Live reference rates (European Central Bank, through Frankfurter) | Verified live | Smoke test read USD/EUR 0.89174 for 10 Nov 2026. One of two runs hit a network drop and reported it cleanly. |
| Analytics queries | Verified | `test/api.test.ts` |

## Stage 8. Front end

| Item | State |
|---|---|
| Merchant web app (11 screens) | **Not built** |
| Customer claim pages | **Not built** |

The API the screens need exists and is tested. The old prototype's console in `make-good/public` still runs against the old prototype only.

## Stage 9. Hardening

| Item | State | Evidence |
|---|---|---|
| Requests from other websites refused | Verified | `test/api.test.ts` |
| Sign-in rate limit | Verified | `test/api.test.ts` |
| Security headers, no-store caching | Built | Not separately tested |
| File upload security | Not built | No uploads yet |
| Load tests | Not built | No performance figures are claimed anywhere |
| Two-connection concurrency on a real PostgreSQL server | **Not verified** | The local engine has one connection. Needs `DATABASE_URL` pointing at a PostgreSQL server |

## Stage 10. Deployment

| Item | State |
|---|---|
| Runs locally with one command, no database to install | Verified |
| Dockerfile, CI workflow, Render configuration | **Not built** |
| Deployed instance | **Not built** |

## Blocked on you

1. **Transaction Search permission.** In the PayPal developer dashboard, open the app and tick Transaction Search under its features. PayPal currently answers `403 NOT_AUTHORIZED`. Without it, payments are fetched one by one from the IDs that orders carry, which works, but duplicate-charge detection and history have nothing to read on a real account.
2. **A store to connect.** A WooCommerce test site or a Shopify development store, for a real connector.
3. **A Claude key**, when claims are built.
4. **A public address and a registered webhook**, to check webhook signatures against PayPal.
5. **PayPal partner approval.** Only matters for a hosted product serving other merchants. Not needed for the hackathon.

Done since the first version of this list: the PayPal sandbox keys are in `make-good/.env` and work.
