# Make Good

Pay back many customers at once, correctly, through PayPal.

When a shop has to refund a lot of people (a faulty batch, a cancelled event, an overcharge, a double charge), Make Good finds who is owed money, says how sure it is about each customer, and sends the refunds after one approval.

Built for the PayPal AI Hackathon 2026.

## The idea in one minute

PayPal knows who paid, when and how much. It does not know which batch of a product a customer received. So Make Good joins two things: the shop's PayPal payments and the shop's own order file. Every customer gets a precision level:

| Level | What we know | What happens |
|---|---|---|
| 1 Exact | The batch is recorded on the order | Refunded after the merchant approves |
| 2 Likely | No batch recorded, but shipped while the bad batch was going out | The customer confirms the batch code first |
| 3 Product only | Right product, no batch or ship date | The customer confirms first |
| 4 Amount only | A PayPal payment with no item details and no order | The customer confirms first |
| 5 Claim | No record at all | A claim, reviewed by a person |

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
5. Open a customer's confirm page from the **Customers** tab and type `B-2217`.
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

| Part | Status |
|---|---|
| Matching, precision levels, amounts, batches, approval, claims, review, report | Built and working |
| Refunds, payouts, read-back, transaction search against the offline mock | Built and tested |
| The same calls against the real PayPal sandbox | Written, not yet tested with keys |
| Seeding real sandbox payments | Not built yet |
| Webhook endpoint with signature check | Written, not yet tested |
| Claude for rule drafting and claim reading | Written, not yet tested with a key |
| Sample shop, orders and payments in MOCK mode | Sample data, labelled on screen |

## PayPal APIs used

| Job | Call |
|---|---|
| Read payments | `GET /v1/reporting/transactions` (31 days per request) |
| Refund | `POST /v2/payments/captures/{id}/refund` with a `PayPal-Request-Id` |
| Check a refund | `GET /v2/payments/refunds/{id}` |
| Pay by email | `POST /v1/payments/payouts`, then `GET /v1/payments/payouts/{id}` |
| Skip disputed payments | `GET /v1/customer/disputes` |
| Balance check | `GET /v1/reporting/balances` |
| Webhooks | `POST /v1/notifications/verify-webhook-signature` |

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
