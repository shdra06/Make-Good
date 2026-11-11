# Make Good: implementation checklist

Last updated 10 Nov 2026. A line is marked **Verified** only after it ran and passed. The evidence column says what was run.

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

`npm test` runs 82 automated tests against a real PostgreSQL engine running in-process (PGlite). `npm run smoke` drives a running server over HTTP. Neither touches PayPal: they use the built-in simulator.

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

| Item | State | Evidence |
|---|---|---|
| PayPal REST client: token, capture lookup, refund, refund lookup, Transaction Search, payouts, disputes, webhook check | Built, not verified | `src/modules/paypal/rest-client.ts`. Fields checked against PayPal's OpenAPI files. **Never called against the sandbox.** |
| Real sandbox run of the above | **Blocked** | No PayPal keys in `make-good/.env` or `apps/api/.env` (both checked: every PayPal value is empty) |
| Idempotent requests (one request ID per operation, for ever) | Verified on the simulator | `test/execution.test.ts` |
| Transaction sync in 31-day slices, with paging | Verified on the simulator | `test/execution.test.ts`, smoke test |
| Refund totals recomputed from PayPal's refund rows | Verified on the simulator | `test/execution.test.ts` |
| Webhooks: stored once, signature checked, unverified events never acted on | Verified on the simulator | `test/api.test.ts` "webhooks" |
| Webhook signature check against real PayPal | Built, not verified | Needs keys and a public address |
| Partner onboarding (PayPal's consent screen) | Built, not verified | Request shape follows the spec. **Needs PayPal partner approval**, see `docs/PAYPAL.md` |

## Stage 3. Merchant and commerce integration

| Item | State | Evidence |
|---|---|---|
| One import format for every store, with validation and warnings | Verified | `test/execution.test.ts` (all orders go through it) |
| Order import API (up to 500 per call), stock batch import API | Verified | Smoke test, `test/api.test.ts` |
| Order to payment linking: exact (store reference, invoice ID, custom ID) and heuristic (flagged) | Verified | `test/matching.test.ts`, `test/execution.test.ts` |
| WooCommerce connector | Not built | Needs a test store |
| Shopify connector | Not built | Needs a Shopify partner account and a development store |
| CSV upload | Not built | |
| Real test store linked to real sandbox payments | **Blocked** | Needs PayPal keys and a store |

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
| Lost reply after PayPal acted: resolved, one refund | Verified on the simulator | `test/execution.test.ts` |
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

1. **PayPal sandbox keys.** Both `.env` files are empty. With keys I can run every "Built, not verified" PayPal line against the sandbox.
2. **A store to connect.** A WooCommerce test site or a Shopify development store, for a real connector.
3. **A Claude key**, when claims are built.
4. **PayPal partner approval.** Only matters for a hosted product serving other merchants. Not needed for the hackathon.
