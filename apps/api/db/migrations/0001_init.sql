-- Make Good: initial schema.
--
-- Conventions
--   * Every tenant table carries org_id. Children reference parents with a
--     composite key (org_id, id), so a row can never point at another
--     organisation's data, even if application code has a bug.
--   * Money is bigint minor units plus a 3-letter currency. Never floats.
--   * Enumerations are text with CHECK constraints (simple to extend later).
--   * Timestamps are timestamptz.

-- =====================================================================
-- Identity and tenancy
-- =====================================================================

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  email_normalized text not null unique,
  name             text not null,
  password_hash    text not null,
  created_at       timestamptz not null default now(),
  disabled_at      timestamptz
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  token_hash   text not null unique,              -- the token itself is never stored
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
create index sessions_user on sessions (user_id);

create table organisations (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  default_currency char(3) not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  settings         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create table memberships (
  org_id     uuid not null references organisations on delete cascade,
  user_id    uuid not null references users on delete cascade,
  role       text not null check (role in ('owner','admin','finance_approver','operator','reviewer','viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);

-- =====================================================================
-- Connections to outside systems
-- =====================================================================

create table paypal_connections (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations on delete cascade,
  environment       text not null check (environment in ('sandbox','live','simulator')),
  -- first_party: the merchant's own REST app (development and self-hosted use)
  -- partner:     PayPal seller onboarding; we act for the merchant with our
  --              platform credentials. Needs PayPal partner approval.
  -- simulator:   no PayPal at all. A built-in model for tests and local trials,
  --              labelled as such everywhere.
  mode              text not null check (mode in ('first_party','partner','simulator')),
  client_id         text,
  secret_ciphertext text,
  merchant_id       text,
  webhook_id        text,
  status            text not null default 'pending' check (status in ('pending','connected','invalid','revoked')),
  capabilities      jsonb not null default '{}'::jsonb,
  last_verified_at  timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, environment),
  unique (org_id, id),
  check ((environment = 'simulator') = (mode = 'simulator')),
  check (status in ('pending','revoked')
         or mode = 'simulator'
         or (mode = 'first_party' and client_id is not null and secret_ciphertext is not null)
         or (mode = 'partner' and merchant_id is not null))
);

create table commerce_connections (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organisations on delete cascade,
  kind                      text not null check (kind in ('csv','custom','woocommerce','shopify')),
  name                      text not null,
  base_url                  text,
  credentials_ciphertext    text,
  webhook_secret_ciphertext text,
  status                    text not null default 'connected' check (status in ('connected','invalid','disabled')),
  sync_cursor               jsonb not null default '{}'::jsonb,
  last_synced_at            timestamptz,
  last_error                text,
  created_at                timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, name)
);

create table sync_runs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organisations on delete cascade,
  source         text not null check (source in ('paypal_transactions','commerce_orders','file_import')),
  connection_ref uuid,
  status         text not null default 'running' check (status in ('running','succeeded','failed')),
  window_start   timestamptz,
  window_end     timestamptz,
  stats          jsonb not null default '{}'::jsonb,
  error          text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index sync_runs_org on sync_runs (org_id, started_at desc);

-- =====================================================================
-- Catalogue, stock and orders (from the merchant's own systems)
-- =====================================================================

create table products (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations on delete cascade,
  connection_id uuid,
  external_id   text,
  title         text not null,
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, connection_id) references commerce_connections (org_id, id)
);
create unique index products_external on products (org_id, connection_id, external_id) where external_id is not null;

create table product_variants (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  product_id  uuid not null,
  sku         text not null,
  title       text,
  external_id text,
  is_bundle   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, sku),
  foreign key (org_id, product_id) references products (org_id, id) on delete cascade
);

create table bundle_components (
  org_id               uuid not null,
  bundle_variant_id    uuid not null,
  component_variant_id uuid not null,
  quantity             int  not null check (quantity > 0),
  primary key (org_id, bundle_variant_id, component_variant_id),
  foreign key (org_id, bundle_variant_id) references product_variants (org_id, id) on delete cascade,
  foreign key (org_id, component_variant_id) references product_variants (org_id, id) on delete cascade,
  check (bundle_variant_id <> component_variant_id)
);

-- A manufacturing batch (lot) of one variant as received into one warehouse.
-- first/last_shipped_at say when units of this batch were leaving that
-- warehouse. They are what lets us reason about mixed stock.
create table inventory_batches (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations on delete cascade,
  variant_id       uuid not null,
  batch_code       text not null,
  warehouse        text not null default 'default',
  quantity         int check (quantity is null or quantity >= 0),
  received_at      timestamptz,
  first_shipped_at timestamptz,
  last_shipped_at  timestamptz,
  note             text,
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, variant_id, batch_code, warehouse),
  foreign key (org_id, variant_id) references product_variants (org_id, id) on delete cascade,
  check (first_shipped_at is null or last_shipped_at is null or first_shipped_at <= last_shipped_at)
);

create table orders (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organisations on delete cascade,
  connection_id             uuid not null,
  external_id               text not null,
  order_number              text not null,
  channel                   text not null default 'online' check (channel in ('online','pos','marketplace','subscription','other')),
  placed_at                 timestamptz not null,
  currency                  char(3) not null check (currency ~ '^[A-Z]{3}$'),
  customer_email            text,
  customer_email_normalized text,
  customer_name             text,
  customer_external_id      text,
  is_guest                  boolean not null default false,
  billing_email             text,
  shipping_name             text,
  shipping_country          char(2),
  payment_method            text not null default 'unknown' check (payment_method in ('paypal','card','cash','bank','other','unknown')),
  payment_reference         text,           -- the payment ID the store recorded, if any
  subtotal_minor            bigint not null check (subtotal_minor >= 0),
  discount_minor            bigint not null default 0 check (discount_minor >= 0),
  shipping_minor            bigint not null default 0 check (shipping_minor >= 0),
  tax_minor                 bigint not null default 0 check (tax_minor >= 0),
  total_minor               bigint not null check (total_minor >= 0),
  status                    text not null default 'paid' check (status in ('pending','paid','partially_refunded','refunded','cancelled')),
  raw                       jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, connection_id, external_id),
  foreign key (org_id, connection_id) references commerce_connections (org_id, id)
);
create index orders_number on orders (org_id, order_number);
create index orders_email on orders (org_id, customer_email_normalized);
create index orders_placed on orders (org_id, placed_at);
create index orders_payment_reference on orders (org_id, payment_reference) where payment_reference is not null;

create table order_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations on delete cascade,
  order_id         uuid not null,
  external_id      text,
  variant_id       uuid,
  sku              text,
  title            text not null,
  kind             text not null default 'physical' check (kind in ('physical','digital','subscription','ticket','service')),
  quantity         int not null check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_minor   bigint not null default 0 check (discount_minor >= 0),   -- for the whole line
  tax_minor        bigint not null default 0 check (tax_minor >= 0),        -- for the whole line
  parent_line_id   uuid,                 -- a bundle's component lines point at the bundle line
  service_start    timestamptz,          -- for subscriptions and services: the period paid for
  service_end      timestamptz,
  position         int not null default 0,
  unique (org_id, id),
  foreign key (org_id, order_id) references orders (org_id, id) on delete cascade,
  foreign key (org_id, variant_id) references product_variants (org_id, id),
  foreign key (org_id, parent_line_id) references order_lines (org_id, id),
  check (service_start is null or service_end is null or service_start < service_end),
  check (discount_minor <= unit_price_minor * quantity)
);
create index order_lines_order on order_lines (org_id, order_id);
create index order_lines_sku on order_lines (org_id, sku);
create unique index order_lines_external on order_lines (org_id, order_id, external_id) where external_id is not null;

create table fulfilments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  order_id    uuid not null,
  external_id text,
  shipped_at  timestamptz,
  warehouse   text not null default 'default',
  tracking    text,
  unique (org_id, id),
  foreign key (org_id, order_id) references orders (org_id, id) on delete cascade
);
create index fulfilments_order on fulfilments (org_id, order_id);
create unique index fulfilments_external on fulfilments (org_id, order_id, external_id) where external_id is not null;

-- What actually left the warehouse. batch_code and serials are present only
-- when the merchant's warehouse or packing process records them.
create table fulfilment_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations on delete cascade,
  fulfilment_id uuid not null,
  order_line_id uuid not null,
  quantity      int not null check (quantity > 0),
  batch_code    text,
  serials       jsonb not null default '[]'::jsonb,
  unique (org_id, id),
  foreign key (org_id, fulfilment_id) references fulfilments (org_id, id) on delete cascade,
  foreign key (org_id, order_line_id) references order_lines (org_id, id) on delete cascade
);
create index fulfilment_lines_line on fulfilment_lines (org_id, order_line_id);
create index fulfilment_lines_batch on fulfilment_lines (org_id, batch_code) where batch_code is not null;

-- Returns, replacements and refunds recorded by the store.
create table order_adjustments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations on delete cascade,
  order_id      uuid not null,
  order_line_id uuid,
  kind          text not null check (kind in ('return','replacement','store_refund','cancellation')),
  quantity      int not null default 0 check (quantity >= 0),
  amount_minor  bigint not null default 0 check (amount_minor >= 0),
  occurred_at   timestamptz not null,
  note          text,
  external_id   text,
  foreign key (org_id, order_id) references orders (org_id, id) on delete cascade,
  foreign key (org_id, order_line_id) references order_lines (org_id, id) on delete cascade
);
create index order_adjustments_order on order_adjustments (org_id, order_id);
create unique index order_adjustments_external on order_adjustments (org_id, order_id, external_id) where external_id is not null;

-- =====================================================================
-- Payments as PayPal reports them
-- =====================================================================

create table payment_transactions (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organisations on delete cascade,
  paypal_connection_id     uuid,
  provider                 text not null default 'paypal' check (provider in ('paypal')),
  environment              text not null check (environment in ('sandbox','live','simulator')),
  transaction_id           text not null,      -- PayPal's ID. For a v2 payment this is the capture ID.
  kind                     text not null check (kind in ('payment','refund','payout','other')),
  event_code               text,               -- PayPal transaction event code, e.g. T0006
  provider_status          text,               -- as PayPal reports it
  occurred_at              timestamptz not null,
  provider_updated_at      timestamptz,
  currency                 char(3) not null check (currency ~ '^[A-Z]{3}$'),
  gross_minor              bigint not null check (gross_minor >= 0),   -- always positive; `kind` gives direction
  fee_minor                bigint check (fee_minor is null or fee_minor >= 0),
  payer_id                 text,
  payer_email              text,
  payer_email_normalized   text,
  payer_name               text,
  payer_country            char(2),
  invoice_id               text,
  custom_id                text,
  reference_transaction_id text,               -- for a refund: the payment it refunds
  items                    jsonb not null default '[]'::jsonb,
  refunded_minor           bigint not null default 0 check (refunded_minor >= 0),
  dispute_state            text check (dispute_state is null or dispute_state in ('open','resolved')),
  source                   text not null check (source in ('transaction_search','api_lookup','webhook','file_import')),
  raw                      jsonb,
  first_seen_at            timestamptz not null default now(),
  last_synced_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, provider, environment, transaction_id),
  foreign key (org_id, paypal_connection_id) references paypal_connections (org_id, id),
  check (kind <> 'payment' or refunded_minor <= gross_minor)
);
create index payment_tx_time on payment_transactions (org_id, occurred_at);
create index payment_tx_invoice on payment_transactions (org_id, invoice_id) where invoice_id is not null;
create index payment_tx_payer on payment_transactions (org_id, payer_email_normalized);
create index payment_tx_reference on payment_transactions (org_id, reference_transaction_id) where reference_transaction_id is not null;

-- Which PayPal payment paid for which order, and how we know.
create table order_payment_links (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations on delete cascade,
  order_id               uuid not null,
  payment_transaction_id uuid not null,
  method                 text not null check (method in ('store_reference','invoice_id','custom_id','heuristic','manual')),
  strength               text not null check (strength in ('exact','heuristic')),
  detail                 text not null,
  created_at             timestamptz not null default now(),
  unique (org_id, order_id, payment_transaction_id),
  foreign key (org_id, order_id) references orders (org_id, id) on delete cascade,
  foreign key (org_id, payment_transaction_id) references payment_transactions (org_id, id) on delete cascade
);
create index order_payment_links_tx on order_payment_links (org_id, payment_transaction_id);

-- =====================================================================
-- Incidents, rules and matching
-- =====================================================================

create table incidents (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organisations on delete cascade,
  kind               text not null check (kind in ('product_defect','recall','overcharge','duplicate_charge','cancelled_event',
                                                   'subscription_error','service_disruption','failed_delivery','pricing_error','other')),
  title              text not null,
  description        text not null default '',
  status             text not null default 'draft' check (status in ('draft','active','closed','cancelled')),
  public_slug        text unique,
  claims_open        boolean not null default false,
  claim_instructions text,
  created_by         uuid references users,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  closed_at          timestamptz,
  unique (org_id, id),
  check (not claims_open or public_slug is not null)
);
create index incidents_org on incidents (org_id, status, created_at desc);

-- Rules are versioned and never edited. A change makes a new version, so every
-- payment can be traced to the exact rule that produced it.
create table incident_rule_versions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations on delete cascade,
  incident_id  uuid not null,
  version      int not null check (version > 0),
  scope        jsonb not null,
  compensation jsonb not null,
  note         text,
  created_by   uuid references users,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, incident_id, version),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade
);

create table match_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations on delete cascade,
  incident_id     uuid not null,
  rule_version_id uuid not null,
  stats           jsonb not null default '{}'::jsonb,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade,
  foreign key (org_id, rule_version_id) references incident_rule_versions (org_id, id)
);

create table candidates (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations on delete cascade,
  incident_id            uuid not null,
  rule_version_id        uuid not null,
  match_run_id           uuid,
  subject_key            text not null,         -- stable identity, e.g. line:<order line id>
  order_id               uuid,
  order_line_id          uuid,
  payment_transaction_id uuid,
  claim_id               uuid,
  customer_email         text,
  customer_name          text,
  affected_quantity      int not null default 1 check (affected_quantity >= 0),
  classification         text not null check (classification in
                           ('exact_unit','strong_multi_source','likely','product_only','transaction_only','claim_verified')),
  needs_confirmation     boolean not null,
  status                 text not null default 'proposed' check (status in ('proposed','confirmed','excluded','declined')),
  exclusion_code         text,
  reasons                jsonb not null default '[]'::jsonb,
  missing                jsonb not null default '[]'::jsonb,
  facts                  jsonb not null default '{}'::jsonb,   -- figures the compensation rule needs (overcharge per unit, ...)
  recommended_action     text not null,
  confirm_token_hash     text unique,
  decided_by             uuid references users,
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, incident_id, subject_key),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade,
  foreign key (org_id, rule_version_id) references incident_rule_versions (org_id, id),
  foreign key (org_id, order_id) references orders (org_id, id),
  foreign key (org_id, order_line_id) references order_lines (org_id, id),
  foreign key (org_id, payment_transaction_id) references payment_transactions (org_id, id),
  check (status <> 'excluded' or exclusion_code is not null)
);
create index candidates_incident on candidates (org_id, incident_id, classification, status);

create table match_evidence (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations on delete cascade,
  candidate_id uuid not null,
  source       text not null check (source in ('order_line','fulfilment_line','inventory_batch','payment_transaction',
                                               'order_payment_link','order_adjustment','customer_statement','claim_evidence','reviewer')),
  record_id    text,
  fact         text not null,
  strength     text not null check (strength in ('proves','supports','weak','contradicts')),
  created_at   timestamptz not null default now(),
  foreign key (org_id, candidate_id) references candidates (org_id, id) on delete cascade
);
create index match_evidence_candidate on match_evidence (org_id, candidate_id);

-- =====================================================================
-- Compensation
-- =====================================================================

create table compensation_calculations (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organisations on delete cascade,
  candidate_id           uuid not null,
  rule_version_id        uuid not null,
  currency               char(3) not null check (currency ~ '^[A-Z]{3}$'),
  entitlement_minor      bigint not null check (entitlement_minor >= 0),
  already_refunded_minor bigint not null check (already_refunded_minor >= 0),
  payable_minor          bigint not null check (payable_minor >= 0),
  route                  text not null check (route in ('refund_original','payout','manual','none')),
  route_reason           text not null,
  steps                  jsonb not null,        -- the calculation, line by line, with source records
  inputs_hash            text not null,
  is_current             boolean not null default true,
  created_at             timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, candidate_id) references candidates (org_id, id) on delete cascade,
  foreign key (org_id, rule_version_id) references incident_rule_versions (org_id, id),
  check (payable_minor <= entitlement_minor),
  check (route <> 'none' or payable_minor = 0)
);
create unique index compensation_current on compensation_calculations (org_id, candidate_id) where is_current;

-- =====================================================================
-- Approval and execution
-- =====================================================================

create table batches (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations on delete cascade,
  incident_id     uuid not null,
  rule_version_id uuid not null,
  name            text not null,
  status          text not null default 'draft' check (status in
                    ('draft','pending_approval','approved','executing','paused','completed','completed_with_failures','rejected','cancelled')),
  totals          jsonb not null default '{}'::jsonb,
  totals_hash     text,                      -- what approvers signed off; execution refuses if it no longer matches
  paused_reason   text,
  created_by      uuid references users,
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  approved_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id),
  foreign key (org_id, rule_version_id) references incident_rule_versions (org_id, id)
);
create index batches_org on batches (org_id, status, created_at desc);

create table batch_approvals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  batch_id    uuid not null,
  user_id     uuid not null references users,
  decision    text not null check (decision in ('approve','reject')),
  comment     text,
  totals_hash text not null,
  created_at  timestamptz not null default now(),
  unique (org_id, batch_id, user_id),
  foreign key (org_id, batch_id) references batches (org_id, id) on delete cascade
);

-- One movement of money. The state machine is enforced in code
-- (modules/execution/state.ts) and the transitions are written to the audit log.
create table payment_operations (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organisations on delete cascade,
  batch_id                 uuid not null,
  candidate_id             uuid not null,
  calculation_id           uuid not null,
  kind                     text not null check (kind in ('refund','payout')),
  paypal_connection_id     uuid not null,
  capture_id               text,              -- refunds: the PayPal capture being refunded
  recipient_type           text check (recipient_type is null or recipient_type in ('EMAIL','PAYPAL_ID')),
  recipient                text,              -- payouts: who receives it
  currency                 char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor             bigint not null check (amount_minor > 0),
  state                    text not null default 'planned' check (state in
                             ('planned','queued','submitting','unknown','pending_provider','succeeded',
                              'failed_retryable','failed_final','cancelled')),
  idempotency_key          text not null unique,     -- sent to PayPal as PayPal-Request-Id; never changes
  provider_refund_id       text,
  provider_payout_batch_id text,
  provider_payout_item_id  text,
  provider_status          text,
  provider_amount_minor    bigint,
  failure_code             text,
  failure_message          text,
  attempts                 int not null default 0,
  next_attempt_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,
  unique (org_id, id),
  unique (org_id, batch_id, candidate_id),
  foreign key (org_id, batch_id) references batches (org_id, id),
  foreign key (org_id, candidate_id) references candidates (org_id, id),
  foreign key (org_id, calculation_id) references compensation_calculations (org_id, id),
  foreign key (org_id, paypal_connection_id) references paypal_connections (org_id, id),
  check ((kind = 'refund' and capture_id is not null) or (kind = 'payout' and recipient is not null and recipient_type is not null)),
  check (state <> 'succeeded' or (provider_refund_id is not null or provider_payout_item_id is not null))
);
create index payment_operations_batch on payment_operations (org_id, batch_id, state);
-- Only one refund may be in flight against a capture at any time, across all batches.
create unique index payment_operations_one_active_refund on payment_operations (org_id, capture_id)
  where kind = 'refund' and state in ('queued','submitting','unknown','pending_provider','failed_retryable');
-- A candidate is paid at most once, whichever batch it was in.
create unique index payment_operations_one_success_per_candidate on payment_operations (org_id, candidate_id)
  where state in ('queued','submitting','unknown','pending_provider','succeeded');

-- Every call made to the provider for an operation, including the ones that failed.
create table provider_attempts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations on delete cascade,
  operation_id uuid not null,
  attempt_no   int not null check (attempt_no > 0),
  purpose      text not null check (purpose in ('submit','reconcile')),
  request_id   text not null,
  -- null while the call is in flight. A row left null after a crash is the
  -- evidence that the outcome is unknown and must be looked up.
  outcome      text check (outcome is null or outcome in ('accepted','rejected','rate_limited','server_error','timeout','network_error','auth_error')),
  http_status  int,
  debug_id     text,
  error_code   text,
  response     jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (org_id, operation_id, attempt_no),
  foreign key (org_id, operation_id) references payment_operations (org_id, id) on delete cascade
);

-- Webhooks and other events from providers. The unique key makes a repeated delivery harmless.
create table provider_events (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references organisations on delete cascade,
  provider            text not null,
  environment         text not null,
  event_id            text not null,
  event_type          text not null,
  resource_type       text,
  resource_id         text,
  verified            boolean not null,
  verification_detail text,
  payload             jsonb not null,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  processing_result   text,
  unique (provider, event_id)
);
create index provider_events_resource on provider_events (provider, resource_id);

create table reconciliation_runs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  scope       text not null,
  stats       jsonb not null default '{}'::jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (org_id, id)
);

create table reconciliation_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations on delete cascade,
  run_id       uuid not null,
  operation_id uuid,
  kind         text not null check (kind in ('unknown_resolved_succeeded','unknown_resolved_not_found','status_changed',
                                             'amount_mismatch','missing_at_provider','unexpected_provider_refund','still_pending')),
  severity     text not null check (severity in ('info','warning','critical')),
  expected     jsonb,
  actual       jsonb,
  status       text not null default 'open' check (status in ('open','resolved','ignored')),
  resolution   text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  foreign key (org_id, run_id) references reconciliation_runs (org_id, id) on delete cascade,
  foreign key (org_id, operation_id) references payment_operations (org_id, id)
);
create index reconciliation_items_open on reconciliation_items (org_id, status, created_at desc);

-- The durable job queue. A job is inserted in the same transaction as the
-- state change that needs it, so a crash cannot lose the work or run it
-- without the state change (transactional outbox).
create table jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references organisations on delete cascade,
  type         text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'queued' check (status in ('queued','running','succeeded','dead')),
  run_at       timestamptz not null default now(),
  attempts     int not null default 0,
  max_attempts int not null default 10 check (max_attempts > 0),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  dedupe_key   text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index jobs_ready on jobs (run_at) where status = 'queued';
create index jobs_running on jobs (locked_until) where status = 'running';
create unique index jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null and status in ('queued','running');

-- =====================================================================
-- Customer claims
-- =====================================================================

create table claims (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organisations on delete cascade,
  incident_id               uuid not null,
  public_ref                text not null unique,
  access_token_hash         text not null unique,
  claimant_email            text not null,
  claimant_email_normalized text not null,
  claimant_name             text not null,
  statement                 text not null default '',
  declared                  jsonb not null default '{}'::jsonb,     -- what the customer says: order number, batch code, ...
  status                    text not null default 'submitted' check (status in
                              ('submitted','needs_evidence','under_review','approved','rejected','appealed','paid','withdrawn')),
  risk_flags                jsonb not null default '[]'::jsonb,
  candidate_id              uuid,
  submitter_fingerprint     text,                                     -- hashed, for abuse limits only
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade,
  foreign key (org_id, candidate_id) references candidates (org_id, id)
);
create index claims_incident on claims (org_id, incident_id, status, created_at desc);
create index claims_email on claims (org_id, incident_id, claimant_email_normalized);

create table claim_evidence (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations on delete cascade,
  claim_id          uuid not null,
  kind              text not null check (kind in ('receipt','product_label','other')),
  storage_key       text not null,
  original_name     text,
  mime              text not null,
  size_bytes        int not null check (size_bytes > 0),
  sha256            text not null,
  extraction_status text not null default 'pending' check (extraction_status in ('pending','done','failed','skipped')),
  extraction        jsonb,                 -- structured AI output, validated against a schema
  extraction_model  text,
  extraction_error  text,
  uploaded_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, claim_id, sha256),
  foreign key (org_id, claim_id) references claims (org_id, id) on delete cascade
);
create index claim_evidence_sha on claim_evidence (org_id, sha256);

create table claim_events (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations on delete cascade,
  claim_id   uuid not null,
  actor_kind text not null check (actor_kind in ('customer','reviewer','system','ai')),
  actor_id   uuid,
  kind       text not null check (kind in ('submitted','evidence_added','evidence_requested','matched','flagged',
                                           'approved','rejected','appealed','paid','note','withdrawn')),
  body       text,
  visible_to_customer boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (org_id, claim_id) references claims (org_id, id) on delete cascade
);
create index claim_events_claim on claim_events (org_id, claim_id, created_at);

alter table candidates
  add constraint candidates_claim_fk foreign key (org_id, claim_id) references claims (org_id, id);

-- =====================================================================
-- Monitoring, FX, notifications, audit
-- =====================================================================

create table detections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  detector    text not null check (detector in ('duplicate_charge','refund_rate_spike','failed_refunds','unknown_outcomes',
                                                'reconciliation_mismatch','repeat_incident_sku','stale_incident','price_mismatch')),
  severity    text not null check (severity in ('info','warning','critical')),
  title       text not null,
  summary     text not null,
  evidence    jsonb not null default '{}'::jsonb,
  fingerprint text not null,               -- the same finding is never raised twice
  status      text not null default 'open' check (status in ('open','acknowledged','converted','dismissed')),
  incident_id uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, fingerprint),
  foreign key (org_id, incident_id) references incidents (org_id, id)
);
create index detections_open on detections (org_id, status, created_at desc);

-- Reference exchange rates from a public source. Indicative only: these are
-- never the rate PayPal applies to a transaction.
create table fx_rates (
  provider   text not null,
  rate_date  date not null,
  base       char(3) not null,
  quote      char(3) not null,
  rate       numeric(24,12) not null check (rate > 0),
  fetched_at timestamptz not null default now(),
  primary key (provider, rate_date, base, quote)
);

create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organisations on delete cascade,
  channel             text not null check (channel in ('email')),
  template            text not null,
  to_address          text not null,
  subject             text not null,
  body_text           text not null,
  related             jsonb not null default '{}'::jsonb,
  status              text not null default 'queued' check (status in ('queued','sent','failed')),
  transport           text,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);
create index notifications_org on notifications (org_id, created_at desc);

-- Append-only record of who did what. Each row carries a hash of the previous
-- row for the same organisation, so a removed or altered row can be detected.
create table audit_events (
  id            bigint generated always as identity primary key,
  org_id        uuid references organisations,      -- no cascade: audit rows outlive everything else
  actor_kind    text not null check (actor_kind in ('user','system','customer','ai','provider')),
  actor_user_id uuid,
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  data          jsonb not null default '{}'::jsonb,
  ip            text,
  created_at    timestamptz not null default now(),
  prev_hash     text,
  hash          text not null
);
create index audit_events_org on audit_events (org_id, id desc);
create index audit_events_entity on audit_events (org_id, entity_type, entity_id);

create function audit_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;

create trigger audit_events_no_update before update on audit_events
  for each row execute function audit_events_immutable();
create trigger audit_events_no_delete before delete on audit_events
  for each row execute function audit_events_immutable();
