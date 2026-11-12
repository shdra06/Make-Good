-- 0011: a product in an outside catalogue (Channel3) that a named person
-- confirmed is the recalled product, with what a new one cost at retailers
-- when it was looked up. Evidence for pricing a replacement-value option:
-- it never decides who is affected and never pays anyone by itself.
-- Rows are never updated: a new lookup is a new row.
create table catalog_references (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organisations on delete cascade,
  incident_id    uuid not null,
  source         text not null check (source in ('channel3')),
  query          text not null,
  product_id     text not null,
  title          text not null,
  brand          text,
  -- Every offer as read: retailer domain, price, currency, stock, condition. No buy links.
  offers         jsonb not null default '[]'::jsonb,
  basis          text check (basis in ('new_in_stock', 'new_any')),
  currency       char(3) check (currency ~ '^[A-Z]{3}$'),
  offer_count    int not null default 0 check (offer_count >= 0),
  retailer_count int not null default 0 check (retailer_count >= 0),
  median_minor   bigint check (median_minor >= 0),
  min_minor      bigint check (min_minor >= 0),
  max_minor      bigint check (max_minor >= 0),
  retrieved_at   timestamptz not null,
  confirmed_by   uuid not null references users,
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, incident_id) references incidents (org_id, id) on delete cascade,
  check ((median_minor is null) = (currency is null)),
  check (min_minor is null or max_minor is null or min_minor <= max_minor)
);
create index catalog_references_incident on catalog_references (org_id, incident_id, created_at desc);

create function catalog_references_never_change() returns trigger language plpgsql as $$
begin
  raise exception 'A catalogue reference is never changed. Look the product up again to save a new one.';
end $$;
create trigger catalog_references_never_change before update on catalog_references
  for each row execute function catalog_references_never_change();

do $$
declare
  rule constant text := '(nullif(current_setting(''app.org_id'', true), '''') is null or org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)';
begin
  execute 'alter table catalog_references enable row level security';
  execute 'alter table catalog_references force row level security';
  execute 'create policy org_isolation on catalog_references using ' || rule || ' with check ' || rule;
  if exists (select 1 from pg_roles where rolname = 'makegood_app') then
    execute 'grant select, insert on catalog_references to makegood_app';
  end if;
end $$;
