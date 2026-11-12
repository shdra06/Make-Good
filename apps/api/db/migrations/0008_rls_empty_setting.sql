-- 0008: fix the row-level security rules from 0007.
--
-- Once a pooled connection has run one organisation's transaction, app.org_id
-- stays defined on it as '' (empty text) afterwards. The 0007 rules said
-- "'' means no scope, OR org_id = setting::uuid", but PostgreSQL does not
-- promise to evaluate the first part first, so it sometimes cast '' to uuid and
-- failed ("invalid input syntax for type uuid"). nullif() turns '' into NULL
-- before any cast, so the rules can never fail, whatever the order.

do $$
declare
  t text;
  rule constant text := '(nullif(current_setting(''app.org_id'', true), '''') is null or %s = nullif(current_setting(''app.org_id'', true), '''')::uuid)';
begin
  for t in
    select c.table_name from information_schema.columns c
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE'
  loop
    execute format('drop policy if exists org_isolation on %I', t);
    execute format('create policy org_isolation on %I using ' || rule || ' with check ' || rule, t, 'org_id', 'org_id');
  end loop;
  drop policy if exists org_isolation on organisations;
  execute format('create policy org_isolation on organisations using ' || rule || ' with check ' || rule, 'id', 'id');
end $$;
