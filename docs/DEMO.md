# Make Good: the three-minute demo

One story: a supplier recalls one batch of a mug set. The demo shows the hard part (who received that batch, from records that do not agree), then the decision, then PayPal's answer.

## A recording already exists

The existing recording shows the old page (branch `main`). On `production-grade` the page is the new Next.js app and its video tools have not been rebuilt yet, so a new recording is still to be made.

## Before you start

```bash
cd apps/api
```

```bash
npm install
```

```bash
npm start
```

Open http://localhost:4000 and press **Open the recall case**. That creates a fresh demo account and loads 32 invented orders on the built-in PayPal simulator. The two labels at the top of the page stay there throughout: "PayPal: simulator, no real money" and "Merchant records: synthetic (invented)".

The same case also runs on PayPal's real sandbox from the command line (`npm run sandbox:recall`). Show that output for the "real PayPal" part if the judges ask: it lists PayPal's own refund IDs. See `docs/VERIFICATION.md`.

## The script

| Time | On screen | What to do | One line to say |
|---|---|---|---|
| 0:00 to 0:20 | Question 1: the supplier's notice | Scroll the notice. Point at "batch K-0719 only". | "We know which batch is faulty. We do not know which customers received it. PayPal knows who paid, and nothing about batches." |
| 0:20 to 0:45 | Question 1: "What the notice says" | Press **Read it**. Point at one quote and the highlighted sentence in the notice. Press **Save these rules**. | "Each line it read quotes the notice word for word. Nothing applies until I save it, in my name." |
| 0:45 to 1:15 | Question 2: the table of two answers | Press **Find affected customers**. Point at the green cell, then the amber cells. Then the panel "Product codes written differently": press **Same product** on `CM412`, **Different** on `CM-4120`. | "Two separate questions for every buyer: is this their payment, and was their unit affected. No scores. `CM-4120` even carries the recalled batch number. It is a different product, and only a person can say so." |
| 1:15 to 1:45 | Question 3: the Recovery Map | Open order **#5019** (uncertain). Show: Fact, Fact, Inference "points the other way". Open **#4871**: two payments with one order number. | "This customer shipped the week two batches were going out. The records cannot settle it, so they are held, not paid. And this order has two possible payments: a person has to say which." |
| 1:45 to 2:05 | Questions 4 and 5: three options | Point at the third card: "4 customers whose unit no record proves", and the blue box under it. | "Paying on the ship date alone is faster and pays one customer who was not affected. On invented data we can say that, because we know the right answers." |
| 2:05 to 2:25 | Question 6: the payment list | **Build the payment list**, **Send for approval**, **Approve exactly this list**. Point at the version number and the hash. Press **Lose one reply from PayPal**. | "The approval is of this exact list. If a customer, a rule or a balance changes, the approval is withdrawn." |
| 2:25 to 2:50 | Question 7: payments | **Start paying**. Watch one row sit at "Outcome unknown: asking PayPal" while the rest turn to "Paid: confirmed by PayPal". | "One reply was lost. It is unknown, not failed, and we will not send it twice. It settles by asking PayPal with the same request ID." |
| 2:50 to 3:00 | Question 7: results and audit trail | Scroll to "Checked against the known answers" and the audit trail. | "Twenty of twenty-three affected units proven from records, none wrongly, five held for a person, nothing paid twice. Every step is on the record." |

## What to say if asked

- **Is that real PayPal?** The page runs on a simulator, and says so on every screen. The same case was run on PayPal's sandbox with real test payments and real refunds: `docs/VERIFICATION.md` section 2a lists PayPal's refund IDs. Nothing has run on live PayPal, and the code refuses to unless a deliberate setting is made.
- **Is the AI real?** Yes: with `GEMINI_API_KEY` set, Google Gemini reads the notice, gives opinions on look-alike codes and explains held records. It was checked against the real Gemini API (`npm run ai:verify`). Every line it reads must quote the notice, and it never decides who is paid. Without a key, plain text rules read the notice instead.
- **Are the accuracy figures real?** They are counts from this run on invented records whose right answers we fixed in advance. They are not measurements of any merchant.
- **Are customers emailed?** Yes, but the emails are saved as files in `apps/api/.data/outbox`, not sent over the internet. A customer is told they were paid only after PayPal confirmed it, and only once.
- **Have merchants asked for this?** We have not interviewed any. `docs/STRATEGY.md` separates what we verified from what we assume.

## Things not to say

- "We prevent disputes." There is no baseline and nothing was measured.
- "It uses N PayPal APIs." Payment depth shows the work was done. Finding the right customers is the point.
- "The AI decides who is paid." It does not. It has no tool and changes no record.
