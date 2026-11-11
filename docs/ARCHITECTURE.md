# Make Good: architecture

Written 10 Nov 2026. This describes the code in `apps/api`. What is built and what is not is in `docs/CHECKLIST.md`; this file explains why it is built this way.

## 1. What was wrong with the first version

The first report and the prototype in `make-good/src` were designed around a two-day deadline. Read against the goal of a real product, these were the weak points.

| Weakness in the first version | What replaces it |
|---|---|
| The merchant pastes PayPal API keys into a file. One merchant, one process. | Organisations, staff and roles. Each organisation has its own PayPal connection, stored encrypted. PayPal's own consent flow (partner onboarding) is the intended default and is coded, but needs PayPal's approval. |
| SQLite file, no migrations, no tenant column | PostgreSQL schema with 39 tables. Every tenant table carries `org_id`, and children point at parents with `(org_id, id)`, so the database itself refuses a cross-tenant link. |
| Amounts as cents, for two-decimal currencies only; shares and percentages used floating-point division | Integer minor units for any currency PayPal supports (yen has none), exact decimal parsing, BigInt rounding, and a largest-remainder split that always adds back to the total. |
| Matching was one function with five hardcoded levels and string reasons | A pure engine with four incident types. Each result carries its evidence, what is missing, the next action and whether a person must confirm. |
| "Batch by date" treated a ship date as proof | A ship date is only supporting evidence. Inventory records can make it strong; mixed stock keeps it "likely". |
| Payments ran from an in-memory queue inside the server process. A restart lost track of what was in flight. | A durable job queue in the database. Intent is written before PayPal is called, so a restart knows what was in flight. |
| It did use one request ID per item and read refunds back, which was right. But an error on a payout marked the items failed, although PayPal may have paid. | A lost reply becomes "unknown", never "failed", and is settled by asking PayPal. Two database indexes also make a second live refund impossible. |
| One approval button, no record of what was approved | Approvals are bound to a fingerprint of the batch contents. If the contents change, the approval no longer counts. |
| Useful only on the day of a recall | Monitoring that runs on ordinary days: double charges, refund spikes, failed and unanswered payments, mismatches with PayPal, repeat-offender products. |
| No tests | 82 automated tests, including 16 on the money path with injected faults. |
| Mock PayPal mixed into the same screens as real | A simulator that is a separate environment. Its IDs start with `SIM`, its connection says "simulator", and sample data sets a flag on the organisation. |

Not fixed yet: no front end for the new system, no claims portal, no store connectors, and no run against the real PayPal sandbox. See the checklist.

## 2. The shape of the system

**A modular monolith with a worker. PostgreSQL is the only stateful dependency.**

```
            browser (merchant)            browser (customer)          PayPal        stores
                  |                             |                       |             |
                  v                             v                       v             v
        +---------------------------------------------------------------------------------+
        |  API process  (Fastify)                                                         |
        |  auth -> tenant check -> permission -> validation -> module                     |
        +---------------------------------------------------------------------------------+
        |  identity | paypal | commerce | transactions | incidents | matching | comp.     |
        |  execution | detection | fx | reporting | demo            (modules, one codebase)|
        +---------------------------+-----------------------------------------------------+
                                    |  same transaction: state change + job
                                    v
                            +---------------+        +-----------------------------+
                            |  PostgreSQL   | <----> |  Worker process(es)         |
                            |  data, jobs,  |        |  claim job, call PayPal,    |
                            |  audit        |        |  record, reconcile          |
                            +---------------+        +-----------------------------+
```

One codebase, two entry points: `src/server.ts` (API) and `src/worker.ts` (jobs). In development the API runs the worker itself, so one command starts everything.

### Why this and not something else

| Option | Verdict | Reason |
|---|---|---|
| Modular monolith with a worker | **Chosen** | Money operations need one transaction across "what we decided" and "what must happen next". One database and one codebase give that for free. Modules have clear borders, so one can be split out later. |
| Service-oriented (several deployable services) | Not now | Nothing here scales differently enough to justify network calls and distributed transactions between services. |
| Event-driven with a message broker | Not now | We would still need an outbox table to publish events safely. The job table already is that outbox. |
| Microservices | No | A small team would spend its time on infrastructure, and a refund would span several services. |

## 3. Technology, and why

| Choice | Why | What we did not pick, and why |
|---|---|---|
| TypeScript on Node 24, run directly | Node 24 runs TypeScript files without a build step. `tsc` is used only to check types. | A compile step: one more thing to break in deployment. |
| Fastify | Fast, small, good request lifecycle hooks, and `inject()` lets tests call routes without a network port. | NestJS: its decorator-based wiring needs a compiler feature that direct TypeScript execution does not provide, and its container hides dependencies we want visible. Express: weaker typing and no built-in lifecycle. |
| Zod | One schema gives the runtime check, the TypeScript type and the OpenAPI description. | Separate validators and hand-written types drift apart. |
| PostgreSQL | Transactions, constraints, partial unique indexes, `SKIP LOCKED` for the queue. | Document stores: no constraints to protect money. |
| Plain SQL migrations, no ORM | The constraints are the product. They should be readable and reviewable as SQL. | Prisma or Drizzle: fine tools, but they hide check constraints and partial indexes behind their own language. |
| PGlite for local work and tests | Real PostgreSQL compiled to run in-process. Nothing to install, and tests run on the same SQL as production. | SQLite: different SQL, so tests would prove less. Docker: not available on every laptop. |
| Job queue in PostgreSQL | A job is created in the same commit as the state change that needs it. | Redis and BullMQ: a second stateful service, and we would still need an outbox. PayPal's rate limits, not the queue, bound our throughput. |
| PayPal over plain HTTP | Full control of headers (request ID, auth assertion), timeouts and error classes. PayPal's TypeScript SDK does not cover payouts. | The SDK for part and HTTP for the rest: two error models. |
| European Central Bank rates via Frankfurter | Free, public, no key, daily. Enough for reporting and forecasts. | Paid FX feeds: not needed, because we never execute at these rates. |
| React with Vite (planned) | The app is a signed-in dashboard. It needs no server rendering. | Next.js: adds a second server for no benefit here. |

## 4. Modules

All under `apps/api/src/modules`, plus cross-cutting code in `src/platform`.

| Module | Responsibility | State |
|---|---|---|
| `identity` | Accounts, sessions, organisations, roles, permissions, settings | Built and tested |
| `paypal` | Provider interface, REST client, simulator, fault injector, connections, webhooks | Built. Tested on the simulator only |
| `commerce` | The one import format for orders, fulfilments, returns and stock batches | Built and tested |
| `transactions` | Copying PayPal transactions; linking orders to payments | Built and tested on the simulator |
| `incidents` | Incidents, rule versions, loading records, the match run | Built and tested |
| `matching` | Pure engine: who is affected, with what evidence | Built and tested |
| `compensation` | Pure engine: how much, and by which route | Built and tested |
| `execution` | Batches, approvals, the operation state machine, the executor, reconciliation | Built and tested |
| `detection` | Monitoring detectors | Built and tested |
| `fx` | Reference rates, exposure, estimates | Built and tested, live rates verified |
| `reporting` | Read queries for the screens | Built and tested through the API |
| `demo` | Sample data on the simulator | Built and tested |
| claims, evidence, AI, notifications | | Tables only. Not built. |
| `platform` | Database, migrations, money, crypto, audit, jobs, clock, config, errors | Built and tested |

Modules call each other through exported functions. The two engines (`matching`, `compensation`) take plain data and return plain data: no database, no clock, no network. That is where correctness lives, so that is where most tests are.

## 5. How money moves

### The operation state machine

```
planned -> queued -> submitting -> succeeded
                         |-> pending_provider -> succeeded | failed_final
                         |-> unknown -> succeeded | pending_provider | failed_final | failed_retryable
                         |-> failed_final
                         |-> failed_retryable -> queued (an operator resumes) | cancelled
                         |-> queued (rate limited: wait, then again)
```

### The four rules

1. **Intent before action.** The operation moves to `submitting` and an attempt row is committed before PayPal is called. If the process dies anywhere after that, the database shows a call was in flight.
2. **One key, for ever.** Every call for an operation carries the same `PayPal-Request-Id`. PayPal answers a repeated key with the first result.
3. **A timeout is not a failure.** A timeout, a dropped connection or a 5xx becomes `unknown`. An operation leaves `unknown` only by asking PayPal.
4. **No PayPal call inside a database transaction.** Claim, call, record: two short transactions with the call between them.

Two database indexes back this up even if the code is wrong: one live refund per PayPal payment, and one live or successful operation per customer.

### What happens when things go wrong

| Situation | Behaviour | Test |
|---|---|---|
| Reply lost after PayPal refunded | `unknown`, then the same request is repeated with the same key; PayPal returns the first refund | "the reply is lost after PayPal refunded" |
| Request never reached PayPal | `unknown`, then the repeat creates the one refund | "the request never reached PayPal" |
| PayPal returns 5xx repeatedly | Stays `unknown`, backs off, repeats with the same key | "PayPal answers 5xx three times" |
| Worker stops mid-call | A sweep finds operations stuck in `submitting`, marks them `unknown`, and they are looked up | "a worker dies mid-call" |
| Same job delivered twice, or two workers | The second sees the state is not `queued` and stands back | "the same job delivered twice" |
| Rate limited (429) | Back to `queued` after the wait PayPal asked for; not counted as a failure | "a rate limit" |
| Balance too low | Operation waits for the merchant; the whole batch pauses with the reason; resume continues | "not enough balance" |
| Invalid or expired credentials | Operation waits; batch pauses asking to reconnect PayPal | Code path exists; not separately tested |
| Already refunded elsewhere | `failed_final` with PayPal's reason; nobody is paid twice | "refused by PayPal" |
| Dispute opened after approval | `failed_final`; resolve in PayPal | "refused by PayPal" |
| Refund pending at PayPal | `pending_provider`, polled until it completes or fails; a failed one is taken back out of our ledger | "a pending refund" |
| Batch cancelled while an outcome is unknown | The request is **not** repeated. A critical item is raised. PayPal's own transaction records settle it at the next sync. | "cancelling a batch with an unknown outcome" |
| Duplicate webhook | Stored once by PayPal's event ID | "webhooks" |
| Late or forged webhook | A webhook only wakes a lookup. A forged one fails the signature check and is never acted on. | "webhooks" |
| Refund amount differs from what we asked | Recorded as a critical reconciliation item | Code path exists; not separately tested |
| Missing transaction data, wrong order reference | The customer is flagged "confirm payment link"; nothing is paid on a guess | `test/matching.test.ts` |

## 6. Who is affected: the evidence ladder

| Level | Meaning | Example | Paid without a person? |
|---|---|---|---|
| `exact_unit` | A record names the unit, batch, order or payment itself | Batch code written down at packing; one order paid twice | Yes, once the batch is approved |
| `strong_multi_source` | No unit record, but independent merchant records agree | Inventory shows only the affected batch was shipping that day | No. The merchant confirms. |
| `likely` | Consistent, but mixed stock or a single source | Two batches were shipping; or only the merchant's stated ship window | No. The customer confirms. |
| `product_only` | Right product, nothing about batch or date | No fulfilment record | No. The customer confirms. |
| `transaction_only` | Only a payment that fits; no order | PayPal payment with the product code but no store order | No. The customer confirms. |

These are categories with stated grounds. They are not percentages: we have no validated model that could justify a number.

| Case | Handled automatically | Needs a person | Cannot be resolved from records |
|---|---|---|---|
| Several products in one order | Yes: only the affected line | | |
| Several units of one product | Yes, when packing records cover each unit | When units differ and one was returned | Which unit was returned, if not recorded |
| Similar products, different variants | Yes: the SKU must match exactly | | |
| Same customer, several purchases | Yes: one candidate per purchase | | |
| Guest checkout | Yes: the payer on the PayPal payment identifies them | | |
| Partial return | Yes: compensation covers what the customer still has | | |
| Replacement sent | | Yes: the new unit may be from another batch | |
| Order already refunded | Yes: excluded, or reduced to what is left | | |
| Paid by card or cash | Identified as affected | Yes: no PayPal payment to refund | |
| Missing or conflicting merchant records | Flagged with a warning at import | Yes | A batch that nobody recorded |
| Mixed stock | Classified `likely` | | Only the code on the product settles it |
| Subscriptions and service outages | Yes, when the paid period is recorded | When it is not | |
| Duplicate payments | Yes, when both carry the same order or invoice | When only the payment pattern suggests it | |
| Bundles | A fixed amount still works | A priced share of the bundle | The component's share, if not recorded |
| Marketplace, point of sale | | | Not built: no connector |
| Claims with no record | | Yes | Not built yet |

## 7. Security model

| Control | In code | Needs process, review or approval |
|---|---|---|
| Passwords hashed with scrypt; sessions stored as hashes; sign-out revokes on the server | Yes | Password policy and account recovery are not built |
| Every organisation route checks membership, then permission | Yes, tested on all 48 routes | |
| Cross-tenant links refused by the database | Yes | Row-level security as a second layer is not added |
| Least privilege: six roles | Yes | Reviewing who holds which role is a process |
| Approval separate from creation; approval bound to contents | Yes | Choosing the thresholds is the merchant's policy |
| Secrets encrypted at rest; key from the environment | Yes | Key storage, rotation schedule and backups are operations |
| Live PayPal off unless a deliberate phrase is set | Yes | |
| Webhook signature check | Yes | Registering the webhook and its ID is setup |
| Requests from other sites refused; no-store caching; security headers | Yes | |
| Sign-in rate limit | Yes, per process | A shared limiter for several instances |
| Audit trail: append-only, hash chained | Yes | Exporting it off the database for safekeeping |
| Encryption in transit | | Provided by the host (TLS) |
| Data retention and deletion | | Not built. Needs a policy first |
| File upload safety | | Not built: there are no uploads yet |
| Card data | Never handled: PayPal holds it | |

This design does not make the product compliant with any law or standard. Compliance needs legal review of how customer data is used, a data-processing agreement with each merchant, and PayPal's own approval for partner access.

## 8. Decisions on record

1. **Modular monolith with a worker**, not services. Section 2.
2. **The job queue lives in PostgreSQL.** A job and its state change commit together. Revisit if job volume, not PayPal's rate limit, becomes the bottleneck.
3. **SQL migrations, no ORM.** Constraints stay visible.
4. **PGlite for local and test.** Its single connection cannot prove behaviour between two connections; that must be re-run on a PostgreSQL server before production.
5. **Evidence levels, not confidence scores.** A number would claim precision we do not have.
6. **Auto-confirm only when both the unit and the payment are proven.** The batch approval remains the human control.
7. **Reconcile by repeating the request with the same key**, except when the batch was cancelled or the request is over six hours old; then wait for PayPal's records and tell a person.
8. **One payout per operation**, not one PayPal batch for many. Simpler to reason about and to reconcile. Group them later if volume needs it.
9. **Refunds are never converted between currencies.** FX is for reporting and forecasting only.
10. **The simulator is an environment, not a mode of the real client.** Nothing it creates can be shown as PayPal.
11. **First-party credentials are a development path.** Partner onboarding is the product path and waits on PayPal's approval.
