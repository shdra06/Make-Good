# Make Good

Make Good helps a merchant work out exactly who is owed money, why they are owed it, how much they should receive, and what was actually paid.

When a supplier recalls one batch of a product, refunding is the easy part. PayPal knows who paid; it does not know which batch anyone received. The hard part is joining the supplier's notice, the shop's orders and packing records, and PayPal's payments, when those records do not agree. Make Good does that part in the open: every customer record carries the evidence behind it, uncertain cases are held for a person, one exact payment list is approved, and only what PayPal confirms is shown as paid.

## The platform (`apps/api`, `apps/web`)

```bash
cd apps/api
```

```bash
npm install
```

```bash
npm start
```

Open http://localhost:4000 and press **Open the recall case**. It loads 32 invented orders on a built-in PayPal simulator and walks seven questions in order: what went wrong, who might be affected, what the evidence says, what the options are and what each costs, what was approved, and what actually happened. [docs/DEMO.md](docs/DEMO.md) is a three-minute script for it.

| Command (in `apps/api`)  | What it does                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`               | 113 automated tests, on a real PostgreSQL engine running in-process. No PayPal calls.                                                                                        |
| `npm run sandbox:recall` | Runs the same recall case on **PayPal's real sandbox**: real test payments, real refunds, one lost reply, one refusal, one withdrawn approval. Needs sandbox keys in `.env`. |
| `npm run sandbox`        | The earlier sandbox check of the payment path alone.                                                                                                                         |
| `npm run smoke`          | Drives a running server through a recall, a billing error and a currency report on the simulator.                                                                            |

What to read:

| File                                         | What it answers                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/CHECKLIST.md](docs/CHECKLIST.md)       | What is built, what is verified and how, what is blocked                   |
| [docs/STRATEGY.md](docs/STRATEGY.md)         | Who this is for, what we verified about the market and what we only assume |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built and why; the two-question matching; approval manifests     |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Exactly what was run, with PayPal's own IDs                                |
| [docs/PAYPAL.md](docs/PAYPAL.md)             | PayPal facts checked against PayPal's own API files and the sandbox        |

Three rules hold everywhere:

1. AI reads and proposes. It never decides who is affected, never approves and never moves money.
2. Nothing is sent until a person approves one exact, unchangeable payment list. If anything under that list changes, the approval is withdrawn.
3. Nothing is shown as paid until PayPal's own record says so. A lost reply is "unknown", never "failed" and never sent twice.

The AI is Google Gemini (`GEMINI_API_KEY` in `apps/api/.env`), checked against the real API. What is not there yet: no merchant has been interviewed, and the Shopify and WooCommerce imports have not been tried on real stores. Customer emails are sent through Resend when `RESEND_API_KEY` is set, and saved as files otherwise. Live PayPal has never been used and is refused by default.

### Sponsor tools

| Tool                                     | What it does here                                                                                                                                                                                                                                                                                                  | Where                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Render                                   | Hosts the app: one web service (Next.js public, API private) and Render Postgres, set up from the `render.yaml` Blueprint. Live at https://make-good.onrender.com                                                                                                                                                  | `render.yaml`, `scripts/start.mjs`                                                                  |
| Bryntum Scheduler (Community 8.0.1, MIT) | The Timeline step: when each batch shipped, when two batches were mixed, and how long each customer's PayPal 180-day refund window has left. Read only.                                                                                                                                                            | `apps/web/src/components/incident/recall-timeline.tsx`, `apps/api/src/modules/recovery/timeline.ts` |
| Channel3                                 | The Options step: search the product catalogue by name, a person confirms the recalled product, and today's new price is saved, dated, as evidence. It can price a "fixed amount per unit" option. Only the search words are sent. Needs `CHANNEL3_API_KEY`; check it with `npm run catalog:verify` in `apps/api`. | `apps/api/src/modules/catalog/`                                                                     |

---

## The first prototype (`src/`, `public/`)

The rest of this file describes the first prototype: one process, a local file database, a mock PayPal. It still runs as before, on port 3000, and is kept for reference. The platform above replaces it.

When a shop has to refund a lot of people (a faulty batch, a cancelled event, an overcharge, a double charge), Make Good finds who is owed money, says how sure it is about each customer, and sends the refunds after one approval.

Built for the PayPal AI Hackathon 2026.

## The idea in one minute

PayPal knows who paid, when and how much. It does not know which batch of a product a customer received. So Make Good joins two things: the shop's PayPal payments and the shop's own order file. Every customer gets a precision level:

| Level          | What we know                                                     | What happens                               |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| 1 Exact        | The batch is recorded on the order                               | Refunded after the merchant approves       |
| 2 Likely       | No batch recorded, but shipped while the bad batch was going out | The customer confirms the batch code first |
| 3 Product only | Right product, no batch or ship date                             | The customer confirms first                |
| 4 Amount only  | A PayPal payment with no item details and no order               | The customer confirms first                |
| 5 Claim        | No record at all                                                 | A claim, reviewed by a person              |

Three rules hold everywhere:

1. AI drafts, reads and flags. It never approves money.
2. Nothing is sent until a person approves the batch.
3. Nothing is shown as paid until PayPal's own record says so.

## Run it (no keys needed)

Requires Node.js 22.13 or newer.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. With no keys set, everything runs in MOCK mode: a sample shop with about 600 orders is loaded, payments live in an offline stand-in for PayPal, and every ID starts with `MOCK-`.

To run the whole flow in the terminal instead:

```bash
npm run demo
```

## Try the demo

1. On the start page, press **Use the demo story**, then **Draft the rules**.
2. Check the rules and press **Confirm rules and find affected customers**.
3. On **Customers**, see the precision levels. Press **Create a batch**.
4. On **Payments**, press **Approve this batch**, then **Send the money**.
5. Open a customer's confirm page from the **Customers** tab and type `K-0719`.
6. Open the public claim page from the **Claims** tab and file a claim. Decide it as the reviewer.
7. See **Report** for what PayPal confirmed and who did what.
8. Back on the start page, press **Scan the last 120 days** to find double charges.

## Use the real PayPal sandbox

Sandbox keys are free and instant.

1. Go to https://developer.paypal.com and log in with any PayPal account.
2. Open **Apps & Credentials** and make sure **Sandbox** is selected.
3. Under **Testing Tools > Sandbox Accounts**, create a **Business** account with country **United States**.
4. Create an app linked to that business account. Copy its **Client ID** and **Secret**.
5. In the app's **Features**, tick **Transaction search** and save.
6. Copy `.env.example` to `.env` and paste the two values.

Then restart with `npm start`. The header shows `PayPal: SANDBOX`.

For AI, add an `ANTHROPIC_API_KEY` from https://console.anthropic.com to `.env`. Without it, simple built-in rules draft the rules and read claims.

## What is real and what is sample

| Part                                                                           | Status                             |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| Matching, precision levels, amounts, batches, approval, claims, review, report | Built and working                  |
| Refunds, payouts, read-back, transaction search against the offline mock       | Built and tested                   |
| The same calls against the real PayPal sandbox                                 | Written, not yet tested with keys  |
| Seeding real sandbox payments                                                  | Not built yet                      |
| Webhook endpoint with signature check                                          | Written, not yet tested            |
| Claude for rule drafting and claim reading                                     | Written, not yet tested with a key |
| Sample shop, orders and payments in MOCK mode                                  | Sample data, labelled on screen    |

## PayPal APIs used

| Job                    | Call                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| Read payments          | `GET /v1/reporting/transactions` (31 days per request)              |
| Refund                 | `POST /v2/payments/captures/{id}/refund` with a `PayPal-Request-Id` |
| Check a refund         | `GET /v2/payments/refunds/{id}`                                     |
| Pay by email           | `POST /v1/payments/payouts`, then `GET /v1/payments/payouts/{id}`   |
| Skip disputed payments | `GET /v1/customer/disputes`                                         |
| Balance check          | `GET /v1/reporting/balances`                                        |
| Webhooks               | `POST /v1/notifications/verify-webhook-signature`                   |

The client refuses any host except `api-m.sandbox.paypal.com`.

## Project layout

```
src/paypal/    PayPal client: sandbox REST and the offline mock
src/engine/    ledger (read payments, import orders), match (levels and amounts),
               payments (batches and runs), claims, incidents (rules, report, scan)
src/ai/        Claude calls with built-in fallbacks
src/demo.ts    the sample shop
src/server.ts  web server and API
src/cli.ts     end-to-end run in the terminal
public/        the console and the customer pages
```

## Licence

MIT
