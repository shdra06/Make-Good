-- 0006: rate limits kept in the database, so every server process shares them
-- and a restart does not reset them. One fixed window per key.
create table rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         integer not null
);
create index rate_limits_window on rate_limits (window_start);

-- Customer emails can now be sent through Resend as well as written to files.
alter table customer_notices drop constraint customer_notices_transport_check;
alter table customer_notices add constraint customer_notices_transport_check check (transport in ('file', 'resend'));
