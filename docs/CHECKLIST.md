# Make Good: implementation checklist

Last updated 11 Nov 2026, after the product review changes. A line is marked **Verified** only after it ran and passed. The evidence column says what was run.

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

```bash
npm run sandbox:recall
```

`npm test` runs the automated tests against a real PostgreSQL engine running in-process (PGlite). `npm run smoke` drives a running server over HTTP. Neither touches PayPal: they use the built-in simulator. `npm run sandbox` and `npm run sandbox:recall` are the ones that talk to PayPal's real sandbox, using the keys in `make-good/.env`. The second runs the whole HM-300 recall case there.

## Stage 0. The product review, mapped to what was done

An independent product review (10 Nov 2026) and the brief that followed it asked for the changes below. "Review" names the finding in that document.

| Recommendation | State | Evidence |
|---|---|---|
| **Review P0: one customer, one incident.** Lead with a growing ecommerce merchant and a defective batch | Done | The page, the sample case and the demo script are one recall story. Other incident types still work and sit behind it. `docs/STRATEGY.md` |
| **Review P0: unvalidated market.** Do not claim demand | Done as far as honesty goes. **No merchant has been interviewed.** | `docs/STRATEGY.md` separates sourced findings from assumptions and lists the five interview questions |
| **Review P0: misleading confidence.** Separate payment-to-order match from incident eligibility; categories, not probabilities | Verified | `payment_identity` and `eligibility` are stored separately; `decision` is a fixed table. `test/two-questions.test.ts` (16 tests) |
| **Review P0: fragile source data.** Never infer a batch from payment data; show exact, likely and unknown evidence | Verified | Every piece of evidence is marked fact, inference or assumption. The engine refuses "proven" without a packing record or a named person. `test/two-questions.test.ts` "PayPal data alone never proves a batch" |
| Ambiguous payments are held, not paid | Verified | Two payments with one order number, one payment tied to two orders, and guessed links are all `ambiguous`. A confirmation cannot settle them; a named person's reconciliation can. `test/manifest.test.ts`, `test/recall.test.ts` |
| **Review: Recovery Map as the signature screen.** Who is included, excluded or held, and why; evidence; restricted payments; liability | Verified on the simulator, in a browser | `GET /recovery-map`, the page's questions 2 and 3. `test/recall.test.ts` |
| Compare compensation policies and what each costs | Verified | `POST /policies/compare`: a dry calculation that saves and pays nothing. Three default policies, any compensation rule. `test/recall.test.ts` |
| Export the exact approved payment list | Verified | `GET /batches/:id/manifest` (JSON) and `?format=csv`. The CSV carries the list's hash |
| **Review: approval must cover exactly what is paid.** Versioned, immutable; invalidated by a changed rule, a newly matched customer or a refreshed balance | Verified | `approval_manifests` with a database trigger; approvals bound to the hash; withdrawal on change; the worker re-checks before each call. `test/manifest.test.ts` (11 tests) |
| Refund-intent ledger: stable ID, capture, order line, reason, approval and rule version, amount, PayPal refund ID and status | Verified | Columns on `payment_operations`; `GET /ledger`, `GET /ledger/captures/:id` |
| No duplicate payment across incidents | Verified | A purchase paid under another incident is held for a named person; a payment being refunded by another batch waits. `test/manifest.test.ts` |
| A failed refund is never silently turned into a payout; payouts need their own approval | Verified | Payouts go in a batch of their own. `test/manifest.test.ts` "a refund PayPal refuses stays failed" |
| A timeout is never a failure | Verified earlier, unchanged | `test/execution.test.ts`; on the sandbox, see Stage 2 |
| **Review: make AI prove its usefulness.** Evidence tasks, each conclusion citing its source, structured outputs, checked by code, confirmed by a person | Built, and **verified against real Gemini** (see the AI row below) | Reading a notice, an opinion on product-code aliases, explaining a held record. Each has a structured output and a check that drops anything not grounded in the source. Tested with a stand-in model in `test/recall.test.ts`. The pattern-rule reader (no AI) is verified |
| AI never decides eligibility, approves or moves money | Verified | Gemini is called from one file and has no tool. Tests show its output changes no record |
| **Review: 10 to 15 deliberately messy cases with known answers** | Verified | 32 synthetic orders, 29 with a stored right answer. `src/modules/demo/recall-scenario.ts` |
| At least one uncertain case held, not paid | Verified | Five are held on the simulator; one of them is in truth not affected |
| Real sandbox refunds, full and partial, with read-back | **Verified on the sandbox** | 16 refunds, each `COMPLETED` at PayPal for the listed amount; 14 payments fully refunded, 2 partially. `docs/VERIFICATION.md` section 2a |
| A controlled failure and a safe recovery, no duplicate | **Verified on the sandbox** | A reply discarded after PayPal acted: held as unknown, then the same refund returned on asking again. A payment refunded elsewhere: PayPal refused ours, it stayed failed, no payout was made |
| An approval withdrawn by a late order, then a new version approved | **Verified on the sandbox** | Version 1 invalidated and kept; version 2 approved by a second person and paid |
| **Review: metrics measured, not asserted** | Verified | `GET /evaluation`: who is affected (precision, recall, held, missed), which payment, amounts, what was paid, duplicates, completion, work left for people, clock times. Each figure is a count from the run |
| Label synthetic records, sandbox payments and real PayPal answers | Verified | Every screen states the PayPal environment and whether merchant records are synthetic. The manifest records the environment |
| **Review: seven questions in order; a three-minute demo** | Verified in a browser on the simulator | `apps/web/public`, `docs/DEMO.md` |
| **Review P1: one customer batch-code confirmation link** | Verified in tests and in a browser | Staff make a one-use link; the customer types the code; it is stored as evidence and staff still decide. `test/manifest.test.ts`. The link is copied by hand: **no email is sent** |
| **Review: cut payouts, claims, image analysis and duplicate-charge scanning from the critical path** | Done | They remain in the code and the API. None is on the page or in the demo |
| Merchant interviews (five questions) | **Blocked on you** | Needs three to five people who run a shop |

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
| The whole recall case: 27 real payments, matching, people's decisions, payment list versions, 16 refunds, a lost reply, a refusal | **Verified on the sandbox** | `npm run sandbox:recall`, 47 checks, all passed. The merchant records in that run are synthetic. |
| PayPal asked about disputes on each payment before matching | **Verified on the sandbox** | 19 payments asked about; none was in dispute, so an open dispute is still simulator-only |
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
| CSV upload (one row per order line; unreadable rows reported by row number; nothing half-imported) | Verified through the API and parser tests. No upload button on the page yet. | `test/csv.test.ts` |
| Orders linked to real sandbox payments by PayPal's payment ID | **Verified on the sandbox** | The orders came through the import format, not from a store |
| Fetching a payment by ID when Transaction Search is behind or not permitted | Verified on the simulator and the sandbox | `test/execution.test.ts`, `npm run sandbox` |
| A real store (WooCommerce or Shopify) as the source of those orders | **Blocked** | Needs a test store |

## Stage 4. Incidents and matching

| Item | State | Evidence |
|---|---|---|
| Incidents with versioned, never-edited rules | Verified | `test/api.test.ts` |
| Matching engine: two separate answers (payment identity, eligibility), a fixed decision table, evidence marked fact, inference or assumption, missing-information lists | Verified | `test/matching.test.ts` (28 tests), `test/two-questions.test.ts` (16 tests) |
| Buyers shown not to be affected are stored with the record that cleared them | Verified | `test/two-questions.test.ts` |
| Product codes written differently: found by rule, matched only after a person confirms the alias | Verified | `test/two-questions.test.ts`, `test/recall.test.ts` |
| PayPal is asked about disputes on each payment before anyone is called payable | Verified on the simulator and the sandbox | `test/recall.test.ts`, `npm run sandbox:recall` |
| A person's decision is stored as evidence in their name and survives a new match | Verified | `test/manifest.test.ts` |
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
| Versioned, immutable approval manifest; withdrawn when a rule, a customer, an amount or a refundable balance changes; revised into a new version | Verified | `test/manifest.test.ts` (11 tests) |
| The worker checks each payment against the approved manifest and the records immediately before calling PayPal, and withholds it otherwise | Verified on the simulator | `test/manifest.test.ts` |
| Payouts in a batch and approval of their own; one refund per PayPal payment per batch; a purchase paid under another incident is held | Verified | `test/manifest.test.ts`, `test/execution.test.ts` |
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

## Stage 6. Evidence, claims and AI

| Item | State | Evidence |
|---|---|---|
| Tables for claims, evidence and claim events | Verified | Part of the schema |
| Customer claim portal, evidence upload, review, appeal | **Not built** | |
| Supplier notice stored with the incident and read into fields; each field must quote the notice and contain its value, or it is dropped | Verified with the pattern-rule reader | `test/recall.test.ts` |
| Rules are saved only by a person, and cannot contain a code the notice never mentions | Verified | `test/recall.test.ts` |
| AI evidence steps (reading a notice, an opinion on product-code aliases, explaining a held record). Structured outputs, checked by code, no tools | **Verified against real Gemini** (`gemini-flash-latest`, 11 Nov 2026) with `npm run ai:verify`: the notice read correctly with nothing dropped; HM-3000 judged a different product; the title-only order judged the same product; "HM300" (title "Hand Mixer 300W") answered "cannot tell"; the explanation cited only real evidence; nothing changed any record. **Claude not verified**: no Anthropic key. | `scripts/ai-verify.ts`, `.data/ai-verification.json`; stand-in model tests in `test/recall.test.ts` |
| AI reading of receipts and labels sent by customers | **Not built** | Belongs with the claims portal |
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
| The recall story as one page: seven questions in order, the Recovery Map, the record drawer, policy pricing, the payment list with export, live payment status, audit trail, measured results | **Verified by hand in a browser on the simulator** (11 Nov 2026): the full flow, including a person's confirmation, a payment reconciliation and a lost reply resolved with one refund |
| The other merchant screens (dashboard, monitoring, currencies, settings, staff) | **Not built.** The API for them exists and is tested |
| Customer claim pages | **Not built** |

On branch `production-grade` the web app is `apps/web`: Next.js 16, React 19, TypeScript. Seven Playwright browser tests pass (12 Nov 2026), including the whole recall case from notice to PayPal-confirmed refunds with a lost reply, customer emails and the one-time customer link; CI runs them in Chromium. Customer emails are saved as files in `apps/api/.data/outbox` (`test/notices.test.ts`); nothing is sent over the internet. On `main` the page is still the old plain-JavaScript one.

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
| Dockerfile and CI workflow (type check and tests) | **Built, not verified.** No Docker on the development machine; the CI run on GitHub has not been checked |
| Render or other host configuration | **Not built** |
| Deployed instance | **Not built** |

## Blocked on you

1. **Transaction Search permission.** In the PayPal developer dashboard, open the app and tick Transaction Search under its features. PayPal currently answers `403 NOT_AUTHORIZED`. Without it, payments are fetched one by one from the IDs that orders carry, which works, but duplicate-charge detection and history have nothing to read on a real account.
2. **A store to connect.** A WooCommerce test site or a Shopify development store, for a real connector.
3. **The Gemini key.** It is in `apps/api/.env` and works. Make a new one (it was pasted in a chat) and replace it there. Without a key every AI step says it is off and the notice is read by pattern rules.
3a. **Three to five people who run a shop**, for the five interview questions in `docs/STRATEGY.md`. Nothing in this repository shows that a merchant wants this.
4. **A public address and a registered webhook**, to check webhook signatures against PayPal.
5. **PayPal partner approval.** Only matters for a hosted product serving other merchants. Not needed for the hackathon.

Done since the first version of this list: the PayPal sandbox keys are in `make-good/.env` and work.
