-- 0009: error tracking and team invitations.

-- Every server error and failed background job, kept so staff can see what
-- went wrong without reading server logs. org_id is set when the error belongs
-- to one workspace; errors with no workspace are visible only to the operator.
create table error_events (
  id          bigserial primary key,
  org_id      uuid references organisations on delete cascade,
  source      text not null check (source in ('request', 'job')),
  where_      text not null,               -- "GET /api/orgs/:orgId/stores" or a job type
  message     text not null,
  detail      text,                        -- first lines of the stack
  created_at  timestamptz not null default now()
);
create index error_events_org on error_events (org_id, created_at desc);

-- An invitation to join a workspace by email. The link's token is stored only
-- as a hash; it works once and expires.
create table invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations on delete cascade,
  email        text not null,
  role         text not null check (role in ('owner','admin','finance_approver','operator','reviewer','viewer')),
  token_hash   text not null unique,
  invited_by   uuid references users,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references users,
  revoked_at   timestamptz
);
create index invitations_org on invitations (org_id, created_at desc);

do $$
declare
  t text;
  rule constant text := '(nullif(current_setting(''app.org_id'', true), '''') is null or org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)';
begin
  foreach t in array array['error_events', 'invitations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy org_isolation on %I using ' || rule || ' with check ' || rule, t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'makegood_app') then
    execute 'grant select, insert, update, delete on error_events, invitations to makegood_app';
    execute 'grant usage, select on sequence error_events_id_seq to makegood_app';
  end if;
end $$;
