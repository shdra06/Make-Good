// Account recovery: email verification and password reset.
//
// Both work by a link sent to the account's email. The link carries a random
// token; only its hash is stored. A token works once, for one purpose, and
// expires. Asking for a reset never says whether an account exists.

import { z } from "zod";
import { DEFAULT_SCRYPT_COST, hashPassword, newToken, sha256Hex } from "../../platform/crypto.ts";
import { HOUR } from "../../platform/clock.ts";
import type { Queryable } from "../../platform/db/db.ts";
import { ValidationError } from "../../platform/errors.ts";
import type { Mailer } from "../notify/mailer.ts";
import { Credentials, type Deps } from "./service.ts";

type Purpose = "verify_email" | "reset_password";

const LIFETIME: Record<Purpose, number> = { verify_email: 48 * HOUR, reset_password: 1 * HOUR };
/** At most this many links of one kind per account per hour, so the reset form cannot flood an inbox. */
const PER_HOUR = 3;

export const NewPassword = z.object({ token: z.string().min(20).max(80), password: Credentials.shape.password });
export const TokenOnly = z.object({ token: z.string().min(20).max(80) });

export type LinkOutcome = { sent: boolean; reason?: "rate_limited" | "no_mailer" | "already_verified" | "no_account"; url?: string };

async function issue(
  deps: Deps,
  mailer: Mailer | null,
  input: { userId: string; email: string; name: string; purpose: Purpose; publicUrl: string },
): Promise<LinkOutcome> {
  const now = deps.clock.now();
  const [recent] = await deps.db.query<{ n: number }>(
    "select count(*)::int as n from account_tokens where user_id = $1 and purpose = $2 and created_at > $3",
    [input.userId, input.purpose, new Date(now.getTime() - HOUR).toISOString()],
  );
  if ((recent?.n ?? 0) >= PER_HOUR) return { sent: false, reason: "rate_limited" };
  if (!mailer) return { sent: false, reason: "no_mailer" };

  const { token, hash } = newToken();
  const [row] = await deps.db.query<{ id: string }>(
    "insert into account_tokens (user_id, purpose, token_hash, email, created_at, expires_at) values ($1, $2, $3, $4, $5, $6) returning id",
    [input.userId, input.purpose, hash, input.email, now.toISOString(), new Date(now.getTime() + LIFETIME[input.purpose]).toISOString()],
  );
  const path = input.purpose === "verify_email" ? "verify-email" : "reset-password";
  const url = `${input.publicUrl.replace(/\/$/, "")}/${path}/${token}`;
  const text =
    input.purpose === "verify_email"
      ? [`Hello ${input.name},`, "", "Confirm this is your email address for Make Good:", url, "", "The link works once and expires in 48 hours.",
         "If you did not create an account, ignore this email."]
      : [`Hello ${input.name},`, "", "Someone asked to reset your Make Good password. To choose a new one, open:", url, "",
         "The link works once and expires in one hour. Every device signed in to your account will be signed out.",
         "If you did not ask for this, ignore this email; your password stays the same."];
  await mailer.send({
    id: row!.id,
    to: input.email,
    subject: input.purpose === "verify_email" ? "Confirm your email for Make Good" : "Reset your Make Good password",
    text: text.join("\n"),
    at: now,
  });
  return { sent: true, url };
}

/** Takes a token for one purpose. Throws the same error for unknown, used and expired tokens. */
async function consume(deps: Deps, token: string, purpose: Purpose, tx: Queryable): Promise<{ userId: string; email: string }> {
  const now = deps.clock.now().toISOString();
  const rows = await tx.query<{ user_id: string; email: string }>(
    `update account_tokens set used_at = $3
      where token_hash = $1 and purpose = $2 and used_at is null and expires_at > $3
      returning user_id, email`,
    [sha256Hex(token), purpose, now],
  );
  if (!rows[0]) throw new ValidationError("This link is not valid any more. It may have been used already or expired. Ask for a new one.");
  return { userId: rows[0].user_id, email: rows[0].email };
}

export async function sendVerification(deps: Deps, mailer: Mailer | null, input: { userId: string; publicUrl: string }): Promise<LinkOutcome> {
  const [user] = await deps.db.query<{ email: string; name: string; email_verified_at: Date | null }>(
    "select email, name, email_verified_at from users where id = $1 and disabled_at is null",
    [input.userId],
  );
  if (!user) return { sent: false, reason: "no_account" };
  if (user.email_verified_at) return { sent: false, reason: "already_verified" };
  return issue(deps, mailer, { userId: input.userId, email: user.email, name: user.name, purpose: "verify_email", publicUrl: input.publicUrl });
}

export async function verifyEmail(deps: Deps, token: string): Promise<{ email: string }> {
  return deps.db.tx(async (tx) => {
    const { userId, email } = await consume(deps, token, "verify_email", tx);
    // The link proves the address it was sent to. If the account's email has changed since, it proves nothing.
    const rows = await tx.query(
      "update users set email_verified_at = coalesce(email_verified_at, $2) where id = $1 and email = $3 returning id",
      [userId, deps.clock.now().toISOString(), email],
    );
    if (!rows[0]) throw new ValidationError("This link was for a different email address. Ask for a new one.");
    return { email };
  });
}

/** Always looks the same to the caller, whether or not the account exists. */
export async function requestPasswordReset(deps: Deps, mailer: Mailer | null, input: { email: string; publicUrl: string }): Promise<LinkOutcome> {
  const [user] = await deps.db.query<{ id: string; email: string; name: string }>(
    "select id, email, name from users where email_normalized = $1 and disabled_at is null",
    [input.email.trim().toLowerCase()],
  );
  if (!user) return { sent: false, reason: "no_account" };
  return issue(deps, mailer, { userId: user.id, email: user.email, name: user.name, purpose: "reset_password", publicUrl: input.publicUrl });
}

/** Sets a new password and signs out every session. Opening the link also proves the email address. */
export async function resetPassword(deps: Deps, input: z.infer<typeof NewPassword>): Promise<{ email: string }> {
  const hash = await hashPassword(input.password, deps.passwordCost ?? DEFAULT_SCRYPT_COST);
  return deps.db.tx(async (tx) => {
    const { userId, email } = await consume(deps, input.token, "reset_password", tx);
    const now = deps.clock.now().toISOString();
    await tx.query(
      "update users set password_hash = $2, email_verified_at = case when email = $4 then coalesce(email_verified_at, $3) else email_verified_at end where id = $1",
      [userId, hash, now, email],
    );
    await tx.query("update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
    // Other reset links for this account stop working too.
    await tx.query("update account_tokens set used_at = $2 where user_id = $1 and purpose = 'reset_password' and used_at is null", [userId, now]);
    return { email };
  });
}
