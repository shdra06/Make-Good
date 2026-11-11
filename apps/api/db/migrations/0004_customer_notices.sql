-- 0004: emails to customers. Each one is kept here, word for word, so staff
-- can see exactly what a customer was told and when. A paid customer is told
-- once per payment (the unique index), however often the button is pressed.
create table customer_notices (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organisations on delete cascade,
  incident_id          uuid not null,
  candidate_id         uuid not null,
  payment_operation_id uuid,
  kind                 text not null check (kind in ('confirm_request', 'payment_sent')),
  to_email             text not null,
  subject              text not null,
  body                 text not null,
  transport            text not null check (transport in ('file')),
  delivery_ref         text,
  created_by           uuid references users,
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade,
  check ((kind = 'payment_sent') = (payment_operation_id is not null))
);
create unique index customer_notices_one_per_payment on customer_notices (org_id, payment_operation_id) where payment_operation_id is not null;
create index customer_notices_incident on customer_notices (org_id, incident_id, created_at);
