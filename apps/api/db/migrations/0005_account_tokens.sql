-- 0005: email verification and password reset. A link's token is never stored,
-- only its hash, so a copy of the database cannot be used to reset a password.
-- Each token works once and expires.
alter table users add column email_verified_at timestamptz;

create table account_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  purpose     text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash  text not null unique,
  email       text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index account_tokens_user on account_tokens (user_id, purpose, created_at);
