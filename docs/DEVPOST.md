# Devpost submission text

Paste the part under "About the project" into the story box. The tags are at the end.

---

## About the project

## Inspiration

A supplier emails a shop: batch K-0719 of a mug set has a glaze fault, please refund affected customers. Sounds simple. Then you open PayPal and see 32 orders for that mug set, and nothing in PayPal tells you which batch each customer got. The batch code lives on a packing slip, or in a spreadsheet someone kept, or nowhere.

So the shop does one of two bad things. Refunds everyone, and loses money on people who were never affected. Or refunds by hand from a spreadsheet, misses some people, pays a few twice, and has no record of why anyone got what they got.

Pressing "refund" in PayPal is the easy part. The hard part is working out who is owed money, why, and how much, when the supplier notice, the shop's orders and PayPal's payments don't agree. That's what we built Make Good for.

## What it does

Make Good takes a recall from "the supplier sent an email" to "PayPal confirms these people were paid".

1. **Read the notice.** Gemini reads the supplier's notice and pulls out the product, the batch codes and the dates. Plain rule checks then confirm every value actually appears in the document. If it doesn't, the value is thrown out.
2. **Find who's affected.** For each order, Make Good answers two separate questions: _is this the right PayPal payment?_ and _did this customer get the bad batch?_ PayPal data can answer the first. It can never answer the second. Orders that are missing evidence are held for a person instead of guessed.
3. **Ask the customer.** If a record is unclear, the customer gets a link to a claims page where they can upload a photo of the batch code.
4. **See it on a timeline.** A Bryntum Scheduler chart shows when each batch shipped, where two batches were mixed in stock, and how many days each customer's PayPal refund window has left (PayPal allows 180 days). Records still owed whose window closes within 30 days are listed first.
5. **Price it.** The shop picks a refund rule (full, half, or a fixed amount per unit). Make Good shows what each option costs, taking tax, shipping, discounts and earlier refunds into account. For "what would a replacement cost?", it searches Channel3's product catalogue by name. A person confirms the right product, and today's price is saved with the date and the number of retailers, so it can be used as evidence.
6. **Approve one exact list.** The final payment list is frozen. The person who built it cannot approve it; a second person must. If anything under it changes afterwards (a new customer, a new rule, a refund made directly in PayPal), the approval is withdrawn.
7. **Pay through PayPal.** A background worker sends refunds with the PayPal Payments API. Each call carries a `PayPal-Request-Id`, so a retry after a lost reply never pays twice. If a refund is refused, Make Good does not quietly switch to a payout.
8. **Show only what PayPal confirms.** A refund counts as paid only when PayPal's own record says so. A lost reply shows as "unknown", never as "failed".

Gemini also writes a short explanation for every record that's waiting on a person, citing only the numbered evidence it was given (E1, E2...). It has no tools. It can't decide who's affected, approve anything or move money.

## How we built it

- **Backend:** Fastify 5 and TypeScript on Node 24, with PostgreSQL (PGlite for local work and tests, managed Postgres on Render). A job queue in the database runs the refund worker, staff alerts and emails.
- **Frontend:** Next.js 16, React 19, Tailwind 4 and TanStack Query. The landing page has a small Three.js scene.
- **PayPal:** OAuth, the Orders API (to create sandbox test payments), the Payments API (look up captures, refund them, read refunds back), Payouts, and dispute checks. Everything runs on the sandbox; live mode is refused by default.
- **AI:** Google Gemini over plain HTTPS, with JSON output held to a schema. Three jobs: read the supplier notice, say whether an odd product code on an order means a catalogue product, and explain why a record is held.
- **Security:** customer names, emails and addresses are encrypted at rest (AES-256-GCM), row-level security keeps each workspace's data apart, and there's CSRF protection and rate limits.
- **Also built:** Shopify and WooCommerce order import, team invitations, email via Resend, monitoring and analytics pages, a workspace export, and privacy, terms and AI-use pages.
- **Hosting:** one Render web service plus Render Postgres, set up from a `render.yaml` Blueprint.
- **Bryntum:** the recall timeline uses Bryntum Scheduler, the free Community edition (MIT licence), in read-only mode. The server builds the rows and bars from stock records, ship dates and PayPal payments; the chart only draws them.
- **Channel3:** the catalogue search goes through Channel3's REST API from the server. Only the search words leave Make Good, never customer data. Each confirmed lookup is stored and never changed.

We test it with 145 API tests plus Playwright browser tests. There's also a script that runs the whole recall case against the real PayPal sandbox.

## What we tested on the PayPal sandbox

The script makes real sandbox payments by test card, runs a recall on them, then asks PayPal what actually happened. In the last full run all 47 checks passed: 26 of 26 payments were found by ID, and an approved list of 16 refunds (977.10 USD) went through. The orders and packing records in that case are made up, and the app labels them that way. The payments and refunds are PayPal's.

The sandbox also caught things we'd have got wrong:

- PayPal refused a second payment with the same invoice number (`DUPLICATE_INVOICE_ID`). Two real orders ended up pointing at one payment, and Make Good held both as ambiguous, which was the right call.
- We refunded one payment directly in PayPal after the list was approved. Our refund was refused (`CAPTURE_FULLY_REFUNDED`), stayed marked failed, and no payout was created to cover it.
- Sending the same refund twice with the same request ID gave back the same refund. Only half of each payment had been refunded, so nothing was paid twice.

## Challenges

**Keeping the AI in its lane.** Letting the model decide who gets refunded would have been easy. We didn't trust it to, so every value it extracts is checked against the source text, and it only writes explanations. The decisions are rules plus a person.

**Lost replies.** When a refund call times out, you don't know if the money moved. Most code treats that as a failure and retries, which is how people get paid twice. We had to build a third state, "unknown", and settle it by asking PayPal.

**Row-level security on the live site.** After the first deploy, about a third of requests failed with `invalid input syntax for type uuid: ""`. A pooled connection kept an empty workspace setting, and our Postgres policy cast it to a UUID. A small migration that treats an empty setting as unset fixed it.

**A timeline with no bars.** The Bryntum chart looked fine on our machines and showed only text on the live site. Bryntum's theme uses the CSS `light-dark()` function, and the production CSS build rewrites it into helper variables that only a `color-scheme` rule sets. We had none, so every bar colour came out invalid and was drawn transparent. One line in our global CSS fixed it.

**A price from one shop.** Channel3 often has a product at only one or two retailers, so a "replacement value" can rest on a single price. We show the retailer count and the date next to every price, and a person has to confirm the product before it can be used.

**Things PayPal won't tell you.** Our sandbox app doesn't have Transaction Search, so we can't list every payment. Make Good fetches each one by its ID. And once, cancelling a test payout returned a 500 every time we tried, so one 1.00 USD sandbox payout is still sitting unclaimed.

## What we learned

The refund is the easy bit. Most of the work is in the records around it. We also learned to treat "we don't know" as a real answer. Showing a person an honest "unknown" is better than a confident wrong number, and being honest about uncertainty is most of the product.

## What's next

We haven't talked to a real merchant yet, so that comes first. After that: test the Shopify and WooCommerce imports against real stores, add database backups (that needs a paid Postgres plan), and try the same flow for other mass-refund cases like double charges and cancelled events.

---

## Built with

1. paypal
2. paypal-rest-api
3. paypal-payouts
4. paypal-sandbox
5. gemini
6. google-gemini-api
7. typescript
8. node.js
9. fastify
10. next.js
11. react
12. tailwindcss
13. tanstack-query
14. three.js
15. postgresql
16. pglite
17. zod
18. render
19. resend
20. shopify
21. woocommerce
22. playwright
23. github-actions
24. bryntum
25. channel3

---

## Additional info (form answers)

**Submitter type:** your choice (Individual or Team).
**Country:** your country. **Canada province:** N/A. **Organization name:** N/A.

**New or existing:** New

**If it existed before:** N/A

**How the project meets the main technology requirement:**

PayPal (all in the sandbox):

- OAuth 2.0 client credentials: connects a merchant workspace to its PayPal account and checks which permissions the app has.
- Orders API v2: creates real sandbox test payments by test card for the recall case.
- Payments API v2: looks up each captured payment by its ID, refunds it, and reads the refund back to confirm the status and amount. Every refund sends a `PayPal-Request-Id`, so a retry after a lost reply returns the same refund and never pays twice.
- Payouts API: an option for customers who can't be refunded to the original payment. It is never used to cover a refund PayPal refused.
- Disputes API: checks for open disputes before a payment is refunded.
- PayPal's error names (`CAPTURE_FULLY_REFUNDED`, `DUPLICATE_INVOICE_ID` and others) are mapped to clear states in the app.

AI: Google Gemini (`gemini-flash-latest`, through the Gemini API, with JSON output held to a schema) does three jobs:

1. Reads the supplier's recall notice and pulls out the product, batch codes and dates. Rule checks then make sure each value appears in the document.
2. Says whether an odd product code or title on an order means a product in the catalogue.
3. Writes a short explanation for each customer record that is waiting for a person, citing only the numbered evidence it was given.

Gemini has no tools. It never decides who is owed money, never approves a payment and never moves money. Workspaces can turn it off in Settings.

**Sponsor tools:** tick Render, Bryntum and Channel3.

- Render: hosts the app and its Postgres database from a `render.yaml` Blueprint.
- Bryntum: Scheduler (Community, MIT) draws the recall timeline on the Timeline step.
- Channel3: product catalogue search on the Options step, to price a replacement.

**Repository URL:** https://github.com/shdra06/Make-Good

**Demo URL:** https://make-good.onrender.com

**Testing instructions:**
The site is on Render's free plan, so the first page load can take about a minute while it wakes up.

The quickest way in is to press "Open the recall demo" on the home page. It opens a shop with a recalled mug set (batch K-0719 of CM-412) and 32 made-up orders. It runs on a built-in PayPal simulator, so no keys are needed. Go through the incident tabs in order: Notice ("Read it with pattern rules", then "Save these rules"), Customers ("Find affected customers"), Evidence, Timeline (the Bryntum chart), Options (search a product name such as "stoneware coffee mug set" in the Channel3 panel and confirm one), Approval, Payments and Claims.

To try your own workspace, sign up with any email and create a workspace.

The hosted site uses the simulator. The real PayPal sandbox run is a script: put sandbox keys in `.env` and run `npm run sandbox:recall` in `apps/api`. It takes about 8 minutes. The results and PayPal's own IDs are in `docs/VERIFICATION.md`.

**PayPal experience rating:** 8. This one is your call.

**Why:**
The sandbox behaved like a real system, and that helped us most. Refusals such as `DUPLICATE_INVOICE_ID` and `CAPTURE_FULLY_REFUNDED` found real gaps in our logic, and `PayPal-Request-Id` worked as documented: a repeat call gave back the same refund. Two things cost us time. Transaction Search wasn't granted to our sandbox app, so we had to fetch each payment by its ID. And cancelling a sandbox payout returned HTTP 500 on every try, so one 1.00 USD test payout is still unclaimed.

**Open to contact:** your choice.

**APIMatic / AG Grid questions:** leave blank (not used).

**Age, eligibility and not-an-employee checkboxes:** only you can confirm these.

**AI tools leveraged while working on the project:**
Google Gemini (inside the product, as above) and Claude Code (Anthropic), which we used as a coding assistant to write and test code, debug the deploy and draft the docs.

**Level of learning:** Significant

**AI value for your career:** Yes
