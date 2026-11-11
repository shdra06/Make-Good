# Make Good: product strategy

Written 11 Nov 2026, after an independent product review of the first report. This file says who the product is for, what it promises, what we have checked about the market and what we only assume. The engineering is in `ARCHITECTURE.md`; what is built is in `CHECKLIST.md`.

## 1. The promise

> Make Good helps merchants determine exactly who is owed money, why they are owed it, how much they should receive, and what was actually paid.

The hard problem is not calling PayPal's refund API. It is joining four things that were never designed to agree: the evidence of what went wrong, the merchant's orders and packing records, PayPal's payments, and the money that then moves. Everything in the product is arranged around that join.

## 2. What the review found, and what changed

| Weakness the review named | What was wrong in our work | What changed |
|---|---|---|
| No single customer; too many incident types at once | The first report pitched recalls, billing errors, cancelled events and outages to everyone | One customer and one incident lead: a growing ecommerce merchant, one faulty batch. The page, the sample case and the demo are that one story. |
| A "confidence" ladder that mixed two questions | A customer could be at the top level while it was unclear which payment to refund | Two separate answers per record: payment identity and eligibility. A fixed table gives the next step. No scores. |
| Fragile source data; a batch inferred from dates | Ship dates were already only supporting evidence, but nothing stopped a future change from treating payment data as proof | Every piece of evidence is marked fact, inference or assumption. The engine refuses "proven" for a batch without a packing record or a named person. |
| Approval of a batch is not approval of what is paid | Approvals were bound to a fingerprint of amounts, but a new match or a changed balance did not withdraw them | An immutable, versioned manifest. Any change underneath withdraws the approval. The worker re-checks before every call. |
| AI that drafts text is decoration | The prototype used AI to draft rules and read claims | AI is used only on evidence: reading a notice, product-code aliases, explaining a held record. Each output is checked by code against its source and confirmed by a person. |
| A feature bundle is easy to copy | The report led with the number of PayPal calls | The product leads with the cohort decision and its audit trail. Payment depth is the proof, not the pitch. |
| Too much in the first version | Payouts, claims, image checks and scanning were all "in" | They are out of the flagship path. They stay in the code as expansion. |
| No evidence of demand, no measured outcome | Recall statistics were offered as proof of demand | Demand is stated as unverified. Outcomes are measured on synthetic data with known answers, and labelled as that. |

## 3. Who it is for first

**A growing ecommerce merchant who sells physical products made in batches, takes PayPal, and has just learned that one batch is faulty.**

Why this customer first:

- The incident is concrete and urgent, and it has a clear owner inside the business.
- It is the case where the data problem is hardest: PayPal cannot know the batch, and the merchant's own records often do not record it for every order.
- A wrong decision costs money in both directions: paying people who were not affected, and missing people who were.

Who might be the better customer later (an assumption, see section 5): agencies, commerce platforms, and operators of several storefronts. One merchant may see one such incident in years. Someone who looks after fifty shops sees them regularly.

## 4. What we verified

Section 4a is what we checked ourselves, by running code against PayPal. Section 4b is what a web search found, with the source for each line and whether the page itself was opened.

### 4a. Checked by running it (PayPal sandbox, 11 Nov 2026)

| Finding | How we know |
|---|---|
| PayPal's records identify the payment and the payer, never the batch or serial of what was shipped | The capture and refund records PayPal returned carry amounts, IDs, an invoice number and item text. There is no field for a production batch. |
| A merchant's PayPal app cannot list its own past payments unless Transaction Search is switched on for it | PayPal answered `403 NOT_AUTHORIZED` to this app. Payments could still be read one by one by ID. |
| PayPal refuses a second payment that reuses an invoice number (on this sandbox account) | `DUPLICATE_INVOICE_ID` when the test data tried to make two payments with one order number |
| A refund request repeated with the same request ID returns the first refund and moves no money | Observed on every run, including with a deliberately discarded reply |
| A payment already refunded elsewhere cannot be refunded again | `422 CAPTURE_FULLY_REFUNDED` |

### 4b. Found by web search

Searched on 11 Nov 2026. "Opened" means the page itself was opened and says this. "Snippet" means only a search result was seen. Nothing here is a customer interview.

**How merchants could find affected customers today**

| Finding | Source | Opened? |
|---|---|---|
| Shopify's own inventory features "focus on quantities". Its blog points merchants to a third-party app for lot tracking. | <https://www.shopify.com/blog/perishable-inventory> | Yes |
| WooCommerce's documented inventory fields (SKU, stock, backorders and so on) include no batch or lot field. | <https://woocommerce.com/document/managing-products/product-editor-settings/> | Yes. The absence is read off the field list. |
| Apps that add lot tracking and find orders by batch already exist. Shopify: Freshly ("tracing customer orders to the batch level"), LotWise ("exports the affected orders and customer emails when a lot is recalled"), LotTrack. WooCommerce: Product Batch & Expiration Tracking, WPRobo COA ("email those customers from a single button"), Product Expiry (a "recall lookup", paid version). | <https://apps.shopify.com/freshly>, <https://apps.shopify.com/lotwise>, <https://apps.shopify.com/lot-track>, <https://woocommerce.com/document/product-batch-and-expiration-tracking-for-woocommerce/>, <https://woocommerce.com/products/wprobo-coa/>, <https://wordpress.org/plugins/product-expiry-for-woocommerce/> | Yes |
| None of those listings mentions refunding the affected customers. | Same pages | Yes |

**Refund tooling**

| Finding | Source | Opened? |
|---|---|---|
| Shopify's help describes refunding one order at a time. | <https://help.shopify.com/en/manual/fulfillment/managing-orders/refunding-orders> | Yes |
| Bulk refunds on Shopify are done by spreadsheet import through a third-party app (Matrixify), which itself says "Always test with just one Order first". Two dedicated bulk-refund apps are no longer listed. | <https://matrixify.app/tutorials/refund-existing-shopify-orders-in-bulk/>, <https://apps.shopify.com/bulk-order-refunds> | Yes |
| PayPal: "Process refunds within 180 days of the original capture date". Full and partial refunds are both supported. | <https://developer.paypal.com/checkout/refund-payment>, <https://developer.paypal.com/api/payments/v2/captures-refund> | Yes |
| PayPal has a batch API that can "refund multiple transactions", but it is "a limited-release API to select merchants and partners". | <https://developer.paypal.com/limited-release/batch> | Yes |

**Who must contact buyers**

| Finding | Source | Opened? |
|---|---|---|
| EU General Product Safety Regulation, Article 35(1): distributors and online marketplaces "shall ensure that all affected consumers that can be identified are notified directly and without undue delay". Article 37 requires an "effective, cost-free and timely remedy". | <https://edlaw.eduverse.com/docs/jurisdiction/int/eu/product-safety/gpsr/RECALLS-AND-PENALTIES.md> | Yes, but on a third-party copy. The official EUR-Lex page would not load. |
| US CPSC Recall Handbook: "Direct notice is the most effective method of engaging consumers for recalls". The recalling firm should ask retailers "to help identify consumers who own the product". No separate duty on a retailer to contact buyers was found in it. | <https://www.cpsc.gov/s3fs-public/RecallHandbookFINAL9_2technicalrevision_3052025.pdf> | Yes |
| UK guidance: "The manufacturer must contact all the consumers it knows are affected". Retailers should keep records identifying their suppliers. | <https://www.gov.uk/guidance/product-safety-advice-for-businesses> | Yes |

**How often, and how well recalls reach people**

| Finding | Source | Opened? |
|---|---|---|
| UK Product Safety Database, April 2025 to March 2026: 2,396 notifications; 479 products with "Recall of the product from end users". | <https://www.gov.uk/government/statistics/product-safety-database-annual-reports/product-safety-database-report-2025-to-2026> | Yes |
| EU Safety Gate 2025: 4,671 alerts, "the highest level on record". These are alerts, not recalls. | <https://commission.europa.eu/news-and-media/news/increased-action-against-dangerous-products-eu-2025-2026-03-09_en> | Yes |
| US: 422 CPSC recalls in 2025. | <https://productsafetyletter.com/Free/10185.aspx> | Yes, but it is a secondary source, not CPSC's own count. |
| CPSC, 865 closed cases from 2014 to 2016: "overall correction rate of 65 percent", counting manufacturers, distributors, retailers and consumers together. | <https://www.cpsc.gov/s3fs-public/Recall_Effectiveness_Workshop_Report-2018.pdf> | Yes |
| CPSC slides, 2017: direct recall alerts had a consumer correction rate of 50%; press releases 6%. | <https://www.slideshare.net/slideshow/cpsc-recall-effectiveness-workshop-recall-data/78744492> | Yes. Old data. |

**Products that already do part of this**

| Finding | Source | Opened? |
|---|---|---|
| Claimlane says it "pulls every customer who bought affected SKUs and batches from your connected order data", sends "targeted emails and SMS" and offers "automated refunds". The page does not say whether it moves the money itself. | <https://www.claimlane.com/resources/blog/product-recalls-retail-and-ecommerce> | Yes |
| Sedgwick sells recall handling as a service, including "consumer notifications". Trustwell FoodLogiQ handles recall communication in the food supply chain. Neither page mentions refunds. | <https://www.sedgwick.com/brandprotection/consumer-product>, <https://www.trustwell.com/products/foodlogiq/recall/> | Yes |
| Amazon says it can "directly reach 100% of customers who have bought a recalled product in our store" and "can issue refunds on behalf of the selling partner". | <https://www.aboutamazon.com/news/how-amazon-works/amazon-creates-new-page-to-share-recalls-for-customers> | Yes |

**Looked for and not found:** how often a merchant of a given size faces a recall; any survey of merchant demand for a tool like this; a mass-refund feature in the PayPal dashboard for ordinary business accounts; whether any recall product executes the refund payment itself; consumer response rates newer than 2017.

**What this means for us, read plainly**

- Finding orders by batch is not new. Where the batch was recorded on the order, an existing app can already list the affected customers and email them. Make Good adds little to that case.
- We found nothing that deals with the orders where the batch was *not* recorded, nothing that asks which payment should be refunded when that is unclear, nothing that ties an approval to one exact list, and nothing that executes and reconciles the refunds. Those four are where Make Good is different. Whether merchants value them is untested.
- A merchant who sells only on a marketplace such as Amazon may never need this: the marketplace says it does it for them.
- In the EU, a seller who can identify affected consumers has to notify them directly. That supports the need to identify them, for EU sellers. It says nothing about paying for a tool to do it.
- Low review counts on the lot-tracking apps (two show none) are a warning: the market for the nearest existing tools may be small.

## 5. What we assume, and have not verified

Nothing below has been tested with a merchant. **We have conducted no merchant interviews.** No claim of demand, willingness to pay, or disputes avoided is made anywhere in this repository.

| Assumption | Why we think it | What would test it |
|---|---|---|
| Merchants of this size identify affected customers by hand: an order export, a spreadsheet, and whoever remembers which stock shipped when | It is what the tools found in section 4b would leave them to do | Interview question 2 |
| Batch numbers are often missing from order records, so some customers cannot be placed from records alone | Platforms do not record a batch on an order line by default (section 4b); our test data assumes a gap of this kind | Ask to see a real order export |
| The costly errors are paying the unaffected and missing the affected, and merchants care about both | Reasoning, not evidence | Interview questions 3 and 4 |
| A merchant would trust a tool with refund permission on their PayPal account for a rare event | Unknown. This may be the largest barrier | Interview question 5 |
| Agencies and multi-store operators meet these incidents often enough to pay for a tool | Reasoning: more shops, more incidents | Interview two agencies |
| Pricing per incident fits better than a subscription | Guess | Ask |

The five questions, from the review:

1. Tell me about the last time you proactively refunded ten or more customers for the same incident. What triggered it?
2. How did you identify the affected orders? What data was missing or wrong?
3. Who assembled the list, calculated amounts, approved funds and handled exceptions?
4. How long did it take, and what errors or complaints followed?
5. Would you use a new tool for the next incident? What would block you, or justify a fee?

## 6. Why a merchant would add another tool, and why they might not

For: the store platform holds orders and PayPal holds payments, and neither holds the other's half or the batch. A refund button in either place cannot say who should be refunded. A record of who was paid, why, and on whose approval is something neither gives.

Against, honestly: apps that find orders by batch and email those customers already exist, and at least one product (Claimlane) advertises recall refunds. The event is rare for one merchant. Giving a new tool refund rights on a payment account is a real trust step. A careful person with a spreadsheet can do this for forty orders. The product has to be clearly safer than the spreadsheet, not merely faster, or it will not be used.

## 7. The flagship and the expansion

**Flagship (what the page and the demo show):** one batch recall, from the supplier's notice to PayPal's confirmation. Read the notice; answer the two questions for every buyer; the Recovery Map; price the options; approve one exact list; refund through PayPal; show PayPal's answer; keep the trail.

**Expansion (built, tested, kept out of the flagship path):**

| Capability | State |
|---|---|
| Other incident types: double charges, overcharges, service outages | Matching and compensation built and tested |
| Monitoring on ordinary days: seven detectors | Built and tested on the simulator |
| Payouts when a refund is not possible | Built; now needs its own batch and approval |
| Currency exposure with reference rates | Built; live rates verified |
| Roles, dual control, audit trail, tenant isolation | Built and tested |

**Expansion (not built):** store connectors (Shopify, WooCommerce), the customer claims portal with evidence upload, a batch-code confirmation link for buyers, email notices, partner onboarding through PayPal's consent flow, deployment.

Order of work is set by three things: what a merchant with a recall needs first, what depends on what, and what we can actually verify. It is not set by how many features can be listed.

## 8. How results are measured, and what they are not

The sample case invents 32 orders and stores the right answer for 29 order lines where the matching engine cannot read it. After any run, `GET /evaluation` counts:

- who is affected: units proven and truly affected, units wrongly called proven, units held for a person, units missed;
- which payment: verified and right, verified and wrong, held;
- amounts: calculated against the known amount;
- what was paid: exact, over, under, to someone unaffected, twice;
- how much is left for people, and clock times.

Three levels of evidence are kept apart everywhere:

| Level | What it shows | What it does not show |
|---|---|---|
| Prototype results on synthetic records | The logic does what it says on untidy data we designed | That real merchant data looks like ours |
| Sandbox verification | PayPal's real systems accept, refuse and confirm as the code expects | Behaviour with live money, real buyers, or at volume |
| Merchant validation | Nothing yet | |
