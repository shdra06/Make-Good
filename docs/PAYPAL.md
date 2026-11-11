# Make Good and PayPal

Written 10 Nov 2026.

**How this was checked.** The endpoint names, fields, limits and permission names below were read from PayPal's published OpenAPI files in <https://github.com/paypal/paypal-rest-api-specifications> (folder `openapi/`), downloaded on 10 Nov 2026. Where a fact comes from somewhere else, or was not checked, the table says so.

**What was not done.** No call in this document has been made against PayPal by this code. There are no PayPal keys on this machine yet. Everything marked "our use" is tested against a built-in simulator that follows the rules below.

## 1. The APIs we use

### Sign-in for our server (OAuth)

| | |
|---|---|
| Reference | <https://developer.paypal.com/api/rest/authentication/> |
| Endpoint | `POST /v1/oauth2/token` with `grant_type=client_credentials`, HTTP Basic auth (client ID and secret) |
| Returns | `access_token`, `expires_in`, `scope` (the permissions this app has) |
| Limits | The token expires; we cache it and fetch a new one a minute before expiry, or on a 401 |
| Errors | 401 with `error` and `error_description` |
| Sandbox | Yes. Host `api-m.sandbox.paypal.com`. Live host is `api-m.paypal.com` |
| Our use | `PayPalRestClient.verifyCredentials()`. The returned `scope` list becomes the connection's capabilities, so the screens can say which features PayPal has granted. |

### Refund a payment

| | |
|---|---|
| Reference | <https://developer.paypal.com/docs/api/payments/v2/> (spec file `payments_payment_v2.json`, version 2.12) |
| Endpoint | `POST /v2/payments/captures/{capture_id}/refund` |
| Permission | Scope `https://uri.paypal.com/services/payments/refund` |
| Request | `amount` (leave out for a full refund), `invoice_id` (max 127), `custom_id` (max 127), `note_to_payer` (max 255). Headers: `PayPal-Request-Id` (idempotency), `Prefer: return=representation` (full reply), `PayPal-Auth-Assertion` (when acting for another merchant) |
| Returns | `id`, `status` (`COMPLETED`, `PENDING`, `FAILED`, `CANCELLED`), `amount`, `custom_id`, `seller_payable_breakdown` |
| Limits | Refunds are in the currency of the capture. PayPal refunds an original payment for 180 days (from PayPal's help pages; not in the spec file). |
| Errors | The spec lists only generic error names. The issue names we handle (`CAPTURE_FULLY_REFUNDED`, `REFUND_AMOUNT_EXCEEDED`, `REFUND_TIME_LIMIT_EXCEEDED`, `TRANSACTION_DISPUTED`, `REFUND_FAILED_INSUFFICIENT_FUNDS`, and others) come from PayPal's Payments error reference as quoted in the first project report. **Not re-checked today.** An issue name we do not know is treated as final, never retried automatically. |
| Sandbox | Yes |
| Our use | One refund per affected customer, to the original capture. `custom_id` and `PayPal-Request-Id` both carry our operation key, so we can find the refund in PayPal's records later. |

### Look up a capture or a refund

| | |
|---|---|
| Endpoints | `GET /v2/payments/captures/{capture_id}`, `GET /v2/payments/refunds/{refund_id}` |
| Permission | Captures: `.../services/payments/payment/authcapture`. Refunds: `.../services/payments/refund` |
| Returns | Capture `status`: `COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`, `REFUNDED`, `FAILED`. Refund `status` as above. |
| Our use | Polling a refund that PayPal reported as `PENDING` until it completes or fails. |

### Transaction Search

| | |
|---|---|
| Reference | <https://developer.paypal.com/docs/api/transaction-search/v1/> (spec file `reporting_transactions_v1.json`, version 1.9) |
| Endpoint | `GET /v1/reporting/transactions` |
| Permission | Scope `https://uri.paypal.com/services/reporting/search/read`. It is a setting on the app in the developer dashboard (not re-checked today). |
| Request | `start_date`, `end_date` (both required), `fields=all`, `page_size` (1 to 500, default 100), `page`, optional `transaction_id` |
| Returns | `transaction_details[]` with `transaction_info` (ID, event code, status, amount, fee, invoice ID, custom field, reference ID), `payer_info` (account ID, email, name, country), `cart_info.item_details[]` (item code, name, quantity, unit price); `total_pages`, `total_items`, `last_refreshed_datetime` |
| Limits | At most 31 days per request. Three years of history. A new transaction can take up to three hours to appear. |
| Errors | Generic names only (`INVALID_REQUEST`, `NOT_AUTHORIZED`, `RESOURCE_NOT_FOUND` and so on) |
| Sandbox | Yes |
| Our use | `syncTransactions` walks the period in 31-day slices and pages. Payments are event codes starting `T00`, refunds `T11`. Refund rows carry the payment's ID as their reference, which is how we total what has been refunded. |

### Payouts

| | |
|---|---|
| Reference | <https://developer.paypal.com/docs/api/payments.payouts-batch/v1/> (spec file `payments_payouts_batch_v1.json`, version 1.9) |
| Endpoints | `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}` (`page_size` up to 1000), `GET /v1/payments/payouts-item/{payout_item_id}` |
| Permission | Scope `https://uri.paypal.com/payments/payouts` |
| Request | `sender_batch_header.sender_batch_id`, `email_subject`; `items[]` with `recipient_type` (`EMAIL`, `PHONE`, `PAYPAL_ID`), `receiver`, `amount`, `note`, `sender_item_id` |
| Returns | Batch status: `PENDING`, `PROCESSING`, `SUCCESS`, `DENIED`, `CANCELED`. Item status: `SUCCESS`, `FAILED`, `PENDING`, `UNCLAIMED`, `RETURNED`, `ONHOLD`, `BLOCKED`, `REFUNDED`, `REVERSED` |
| Limits | Up to 15,000 payments per call. A `sender_batch_id` used in the last 30 days is refused, and the refusal links to the original payout. After a 5xx the same `sender_batch_id` can be retried safely. Request IDs are kept for 30 days. |
| Production | Paid from the PayPal balance. Live access must be requested from PayPal. |
| Sandbox | Yes |
| Our use | Only when a refund to the original payment is not possible (older than 180 days, or not paid through PayPal) and the merchant's rule allows it. One payout per operation. If the reply is lost we repeat with the same `sender_batch_id`; a "duplicate" refusal gives us the original payout to read. |

### Disputes

| | |
|---|---|
| Reference | <https://developer.paypal.com/docs/api/customer-disputes/v1/> (spec file `customer_disputes_v1.json`, version 1.11) |
| Endpoint | `GET /v1/customer/disputes?disputed_transaction_id=...` |
| Permission | Scope `https://uri.paypal.com/services/disputes/read-seller` |
| Returns | `dispute_id`, `status` (`OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`, `OTHER`), `dispute_state`, `reason` |
| Limits | Filter by transaction or by start time, not both. Start time within 180 days. |
| Our use | Client method exists. Today the dispute flag on a payment is set from the `CUSTOMER.DISPUTE.*` webhooks, and PayPal's own refusal (`TRANSACTION_DISPUTED`) is the final guard. We only read disputes; we do not act on them. |

### Webhooks

| | |
|---|---|
| Reference | <https://developer.paypal.com/docs/api/webhooks/v1/> (spec file `notifications_webhooks_v1.json`, version 1.11) |
| Endpoint | `POST /v1/notifications/verify-webhook-signature` |
| Request | `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (all from the request headers), `webhook_id`, `webhook_event`. All required. |
| Returns | `verification_status`: `SUCCESS` or `FAILURE` |
| Our use | Every event is stored once by its ID. The event body is passed to PayPal byte for byte. Only a `SUCCESS` event is acted on, and then it only updates our copy of PayPal's ledger and wakes a lookup. Event types handled: `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.*`, `PAYMENT.PAYOUTS-ITEM.*`, `PAYMENT.PAYOUTSBATCH.*`. The event type names are from PayPal's event list page and were **not re-checked today**. |

## 2. Things we do not have

| Thing | Status |
|---|---|
| The batch, lot or serial number of a product | PayPal never has it. It can only come from the merchant's own records. |
| PayPal's fraud or risk scores, buyer complaints | No supported API gives them to a merchant app. No detector uses them. |
| A published rate limit | As far as we know PayPal does not publish numbers (from its rate-limiting guide; not re-checked today). We space requests, honour `Retry-After` on a 429, and never count a 429 as a failure. |
| A bulk refund call | The public API refunds one payment per call (from the research in the first report). That is the gap this product fills. |
| How long PayPal keeps a refund request ID | Stated as 30 days for payouts in the spec. Not stated for refunds in the spec file. We stop repeating a request automatically after six hours and ask a person. **To confirm in the sandbox.** |
| The exchange rate PayPal will use | Not available in advance. Our rates are reference rates and are labelled as estimates. |

## 3. Connecting a merchant

| Way | How it works | Who can use it | State |
|---|---|---|---|
| **Partner onboarding** | Our server calls `POST /v2/customer/partner-referrals` and sends the merchant to PayPal's own consent screen. The merchant grants named features: `PAYMENT`, `REFUND`, `PAYOUTS`, `READ_SELLER_DISPUTE`, `ADVANCED_TRANSACTIONS_SEARCH`, `ACCESS_MERCHANT_INFORMATION`. Afterwards we call PayPal with **our** credentials plus a `PayPal-Auth-Assertion` header naming the merchant. The merchant never gives us a secret, and can withdraw consent in PayPal. | Only an app PayPal has approved as a partner (scope `.../services/customer/partner-referrals/readwrite`) | Coded. Returns a clear "needs partner approval" message until platform credentials are configured. **Not verified.** |
| **Own REST app** | The merchant creates an app in the PayPal developer dashboard and pastes its client ID and secret. We check them with PayPal, then store the secret encrypted (AES-256-GCM). Only the last six characters of the client ID are ever shown again. | Any merchant. Right for development, the sandbox, and one merchant running their own copy. Not the right default for a hosted product. | Coded and tested with a stand-in for PayPal's token endpoint. **Not verified against PayPal.** |
| **Simulator** | No PayPal. A built-in model with the same rules. | Development and tests only. Off in production. | Tested. |

What happens around a connection:

| Event | Behaviour |
|---|---|
| Credentials wrong | Saved with status `invalid` and PayPal's reason, so the merchant sees what to fix |
| Permission missing | Shown per feature (refunds, search, payouts, disputes, webhooks) from the token's scope list |
| Access expires or is revoked mid-batch | The operation waits, the batch pauses with "reconnect PayPal", nothing is lost |
| Merchant disconnects | Refused while payments are in flight. Otherwise the stored secret is wiped and the connection cannot be used again. |
| Sandbox and live | Separate connections. Live is refused unless the server is started with a deliberate phrase in `ALLOW_LIVE_PAYPAL`. |

## 4. What production would need from PayPal

1. Partner approval, to connect merchants through PayPal's consent screen instead of pasted keys.
2. Payouts enabled on the live account (PayPal reviews this).
3. Transaction Search enabled on the app.
4. A registered webhook, with its ID stored on the connection.

None of these is needed to demonstrate the product in the sandbox with one merchant's own app.

## 5. Cross-border rules we follow

| Question | Answer |
|---|---|
| Can a refund be made in another currency? | No. A refund goes to the original payment in its own currency. The engine sends any rule that would mix currencies to a person. |
| Who pays for conversion? | If the merchant's balance is in another currency, PayPal converts and charges its own rate. We cannot see or choose that rate. |
| What do we show? | What is owed per currency and per customer country, a reference-rate estimate in the merchant's currency, and a conversion-cost figure only if the merchant enters their own assumed percentage. |
| Payouts abroad | Supported currencies are the 24 codes kept in `src/platform/money.ts` (from PayPal's currency codes page; not re-checked today). Whether a particular recipient can receive a payout is only known from the payout item's status. A failed or blocked item is reported, not retried. |
| When do we decline? | When the rule's currency differs from the payment's, when there is no PayPal payment and payouts are not allowed, or when a dispute is open. |
