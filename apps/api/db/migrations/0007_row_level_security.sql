-- 0007: row-level security. Every table with an org_id column only shows and
-- accepts rows of the organisation named in the transaction setting app.org_id.
--
-- Every request for one organisation runs in a transaction that sets it (see
-- withOrg in db.ts), so a query that forgets its "where org_id = $1" still
-- cannot see another shop's data. Work that is not for one organisation (sign-in,
-- the job worker, webhooks, migrations) leaves the setting empty and is limited
-- by its own checks, as before.
--
-- FORCE makes the rules apply to the tables' owner too. A superuser (as in
-- PGlite and many local servers) ignores them, so the app switches to the
-- role makegood_app inside each organisation's transaction when it can.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'makegood_app') then
    begin
      create role makegood_app nologin;
    exception when insufficient_privilege then
      raise notice 'Could not create role makegood_app; row-level security relies on FORCE for the owner role.';
    end;
  end if;
  if exists (select 1 from pg_roles where rolname = 'makegood_app') then
    begin
      execute format('grant makegood_app to %I', current_user);
    exception when others then
      raise notice 'Could not grant makegood_app to %', current_user;
    end;
    execute 'grant usage on schema public to makegood_app';
    execute 'grant select, insert, update, delete on all tables in schema public to makegood_app';
    execute 'grant usage, select on all sequences in schema public to makegood_app';
    execute 'alter default privileges in schema public grant select, insert, update, delete on tables to makegood_app';
    execute 'alter default privileges in schema public grant usage, select on sequences to makegood_app';
  end if;
end $$;

do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE'
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I using (coalesce(current_setting(''app.org_id'', true), '''') = '''' or org_id = current_setting(''app.org_id'', true)::uuid)'
      ' with check (coalesce(current_setting(''app.org_id'', true), '''') = '''' or org_id = current_setting(''app.org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

-- An organisation is its own row: inside a scope, only that one is visible.
alter table organisations enable row level security;
alter table organisations force row level security;
drop policy if exists org_isolation on organisations;
create policy org_isolation on organisations
  using (coalesce(current_setting('app.org_id', true), '') = '' or id = current_setting('app.org_id', true)::uuid)
  with check (coalesce(current_setting('app.org_id', true), '') = '' or id = current_setting('app.org_id', true)::uuid);
