-- 0002: evidence-backed recovery.
--
--   1. Matching answers two separate questions for every customer record:
--      does this PayPal payment belong to this order (payment_identity), and
--      does the evidence show this purchase was affected (eligibility).
--   2. An approval covers one exact, unchangeable list of payments: the
--      approval manifest. Workers pay only what the approved manifest lists.
--   3. Every planned movement of money carries its reason, order line, rule
--      and approval version (the refund-intent ledger).
--   4. Incident evidence (supplier notices), what was read out of it, and
--      product-code aliases are stored with who confirmed them.
--   5. Ground-truth labels for synthetic test data, so accuracy is measured
--      and not asserted.

-- ---------- 1. candidates: two independent questions ----------

alter table candidates
  add column payment_identity text not null default 'missing'
    check (payment_identity in ('verified', 'ambiguous', 'missing', 'not_paypal')),
  add column eligibility text not null default 'unknown'
    check (eligibility in ('proven', 'supported', 'uncertain', 'unknown', 'not_affected')),
  add column decision text not null default 'investigate'
    check (decision in ('ready_for_approval', 'needs_eligibility_evidence', 'reconcile_payment', 'investigate',
                        'pay_outside_paypal', 'on_hold', 'excluded', 'not_affected')),
  add column decision_basis text,     -- why a person confirmed or declined
  add column decision_note  text;

-- Rows written before this migration: carry the old single ladder over.
update candidates set
  eligibility = case classification
                  when 'exact_unit' then 'proven'
                  when 'claim_verified' then 'proven'
                  when 'strong_multi_source' then 'supported'
                  when 'likely' then 'uncertain'
                  else 'unknown' end,
  payment_identity = case
                  when facts->>'paymentLinkStrength' = 'exact' then 'verified'
                  when facts->>'paymentLinkStrength' = 'heuristic' then 'ambiguous'
                  when recommended_action = 'pay_outside_paypal' then 'not_paypal'
                  else 'missing' end;
update candidates set decision = case
                  when status = 'excluded' and exclusion_code = 'dispute_open' then 'on_hold'
                  when status = 'excluded' then 'excluded'
                  when eligibility = 'proven' and payment_identity = 'verified' then 'ready_for_approval'
                  when eligibility = 'proven' and payment_identity = 'not_paypal' then 'pay_outside_paypal'
                  when eligibility = 'proven' then 'reconcile_payment'
                  when payment_identity in ('verified', 'not_paypal') then 'needs_eligibility_evidence'
                  else 'investigate' end;

-- "cleared": the records show this purchase was NOT affected. Kept, with its
-- evidence, so a merchant can see why a buyer of the product is left out.
alter table candidates drop constraint candidates_status_check;
alter table candidates add constraint candidates_status_check
  check (status in ('proposed', 'confirmed', 'excluded', 'declined', 'cleared'));

create index candidates_incident_decision on candidates (org_id, incident_id, decision, status);

-- Evidence says which question it answers and what kind of statement it is.
alter table match_evidence
  add column dimension text not null default 'eligibility'
    check (dimension in ('payment', 'eligibility', 'state')),
  add column kind text not null default 'fact'
    check (kind in ('fact', 'inference', 'assumption'));
update match_evidence set dimension = 'payment' where source = 'order_payment_link';
update match_evidence set dimension = 'state' where source = 'order_adjustment';
update match_evidence set kind = 'inference' where strength in ('supports', 'weak') and source in ('inventory_batch', 'payment_transaction');

alter table match_evidence drop constraint match_evidence_source_check;
alter table match_evidence add constraint match_evidence_source_check
  check (source in ('order', 'order_line', 'fulfilment_line', 'inventory_batch', 'payment_transaction',
                    'order_payment_link', 'order_adjustment', 'customer_statement', 'claim_evidence', 'reviewer',
                    'product_alias', 'incident_scope'));

-- A person can settle which payment paid for an order. Record who and why.
alter table order_payment_links
  add column created_by uuid references users,
  add column note text;

-- ---------- 2. approval manifests ----------

alter table batches
  add column kind text not null default 'refund' check (kind in ('refund', 'payout')),
  add column manifest_version int not null default 0,
  add column approved_manifest_id uuid;

create table approval_manifests (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organisations on delete cascade,
  batch_id           uuid not null,
  version            int not null check (version >= 1),
  status             text not null default 'current' check (status in ('current', 'invalidated', 'superseded')),
  content            jsonb not null,       -- every recipient, amount, payment reference, rule and piece of evidence
  content_hash       text not null,        -- sha-256 of the canonical content; approvals are bound to it
  item_count         int not null check (item_count >= 0),
  created_by         uuid references users,
  created_at         timestamptz not null default now(),
  invalidated_at     timestamptz,
  invalidated_reason jsonb,
  unique (org_id, id),
  unique (org_id, batch_id, version),
  foreign key (org_id, batch_id) references batches (org_id, id) on delete cascade,
  check ((status = 'current') = (invalidated_at is null))
);
create unique index approval_manifests_one_current on approval_manifests (org_id, batch_id) where status = 'current';

-- The content of a manifest never changes. It can only stop being current, once.
create function approval_manifests_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'approval manifests are never deleted';
  end if;
  if new.content is distinct from old.content or new.content_hash <> old.content_hash
     or new.version <> old.version or new.batch_id <> old.batch_id or new.org_id <> old.org_id
     or new.item_count <> old.item_count or new.created_at <> old.created_at then
    raise exception 'the content of an approval manifest cannot be changed';
  end if;
  if old.status <> 'current' then
    raise exception 'an approval manifest that is no longer current cannot be changed';
  end if;
  return new;
end $$;
create trigger approval_manifests_no_update before update on approval_manifests
  for each row execute function approval_manifests_guard();
create trigger approval_manifests_no_delete before delete on approval_manifests
  for each row execute function approval_manifests_guard();

alter table batch_approvals
  add column manifest_id uuid,
  add column manifest_hash text;

-- ---------- 3. the refund-intent ledger ----------
-- payment_operations is written before PayPal is called, so it is the record
-- of intent. These columns make each row explain itself.

alter table payment_operations
  add column incident_id uuid,
  add column order_id uuid,
  add column order_line_id uuid,
  add column rule_version_id uuid,
  add column manifest_id uuid,                     -- the manifest this payment was approved under
  add column manifest_version int,
  add column reason text,                          -- why the customer is owed this, in words
  add column capture_gross_minor bigint,           -- the original payment, when the manifest was built
  add column capture_refunded_before_minor bigint; -- already refunded on it, when the manifest was built

update payment_operations op set incident_id = b.incident_id, rule_version_id = b.rule_version_id
  from batches b where b.org_id = op.org_id and b.id = op.batch_id;
update payment_operations op set order_id = c.order_id, order_line_id = c.order_line_id
  from candidates c where c.org_id = op.org_id and c.id = op.candidate_id;

create index payment_operations_capture on payment_operations (org_id, capture_id) where capture_id is not null;
create index payment_operations_order_line on payment_operations (org_id, order_line_id) where order_line_id is not null;

-- ---------- 4. incident evidence, what was read from it, product aliases ----------

create table incident_documents (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  incident_id uuid not null,
  kind        text not null check (kind in ('supplier_notice', 'internal_note', 'other')),
  title       text not null,
  body        text not null,
  sha256      text not null,
  data_label  text not null default 'merchant' check (data_label in ('merchant', 'synthetic')),
  created_by  uuid references users,
  created_at  timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade
);
create index incident_documents_incident on incident_documents (org_id, incident_id, created_at);

create table evidence_extractions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations on delete cascade,
  incident_id     uuid not null,
  document_id     uuid not null,
  method          text not null check (method in ('claude', 'pattern_rules')),
  model           text,                          -- the model that produced it, when method = 'claude'
  output          jsonb not null,                -- fields, each with the exact words it was read from
  warnings        jsonb not null default '[]'::jsonb,
  status          text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected')),
  rule_version_id uuid,                          -- the rules a person saved from it
  decided_by      uuid references users,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade,
  foreign key (org_id, document_id) references incident_documents (org_id, id) on delete cascade,
  check (method <> 'claude' or model is not null)
);
create index evidence_extractions_incident on evidence_extractions (org_id, incident_id, created_at desc);

-- "HM300" on an order means "HM-300" in the catalogue: only once a person says so.
create table product_aliases (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations on delete cascade,
  kind             text not null check (kind in ('sku', 'title')),
  alias            text not null,              -- as written on the order
  alias_normalized text not null,
  canonical_sku    text not null,
  status           text not null default 'suggested' check (status in ('suggested', 'confirmed', 'rejected')),
  source           text not null check (source in ('pattern_rule', 'ai', 'manual')),
  reason           text not null,
  evidence         jsonb not null default '[]'::jsonb,
  model            text,
  line_count       int not null default 0,
  decided_by       uuid references users,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, kind, alias_normalized, canonical_sku),
  check (status = 'suggested' or decided_at is not null)
);
create index product_aliases_lookup on product_aliases (org_id, status, canonical_sku);

-- ---------- 5. ground truth for synthetic data ----------
-- Written only by the sample-data loader, which knows the real answer for
-- each record it invents. Never present for a merchant's own data.

create table evaluation_labels (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organisations on delete cascade,
  dataset            text not null,
  order_id           uuid not null,
  order_line_id      uuid not null,
  case_tag           text not null,
  note               text not null default '',
  affected_units     int not null check (affected_units >= 0),
  owed_minor         bigint not null check (owed_minor >= 0),   -- what a correct refund through PayPal would be
  currency           char(3) not null check (currency ~ '^[A-Z]{3}$'),
  true_capture_id    text,                                      -- the PayPal payment that really paid for the order
  created_at         timestamptz not null default now(),
  unique (org_id, dataset, order_line_id),
  foreign key (org_id, order_id) references orders (org_id, id) on delete cascade,
  foreign key (org_id, order_line_id) references order_lines (org_id, id) on delete cascade
);
