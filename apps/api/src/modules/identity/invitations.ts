// Invitations to a workspace by email.
//
// An owner or admin invites an email address with a role. The link carries a
// random token (only its hash is stored); it works once, for 7 days. Accepting
// needs an account with exactly that email, so a forwarded link is useless to
// anyone else. Opening the link also proves the address, so it is marked verified.

import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import { DAY } from "../../platform/clock.ts";
import { newToken, sha256Hex } from "../../platform/crypto.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../../platform/errors.ts";
import type { Mailer } from "../notify/mailer.ts";
import { ROLES, type Deps, type Role } from "./service.ts";

const LIFETIME = 7 * DAY;
export const NewInvitation = z.object({ email: z.string().trim().email().max(320), role: z.enum(ROLES) });

export async function invite(
  deps: Deps,
  mailer: Mailer | null,
  input: z.infer<typeof NewInvitation> & { orgId: string; actorId: string; actorRole: Role; publicUrl: string },
): Promise<{ id: string; sent: boolean; url: string }> {
  if (input.role === "owner" && input.actorRole !== "owner") throw new ForbiddenError("Only an owner can invite another owner.");
  const email = input.email.trim().toLowerCase();
  const now = deps.clock.now();
  const member = await deps.db.query(
    "select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email_normalized = $2",
    [input.orgId, email],
  );
  if (member.length > 0) throw new ConflictError("ALREADY_MEMBER", "This person is already in the team. Change their role in the list instead.");
  const [recent] = await deps.db.query<{ n: number }>(
    "select count(*)::int as n from invitations where org_id = $1 and created_at > $2",
    [input.orgId, new Date(now.getTime() - DAY).toISOString()],
  );
  if ((recent?.n ?? 0) >= 50) throw new ConflictError("TOO_MANY_INVITATIONS", "This workspace sent 50 invitations in the last day. Try again tomorrow.");

  const { token, hash } = newToken();
  const url = `${input.publicUrl.replace(/\/$/, "")}/invite/${token}`;
  const id = await deps.db.tx(async (tx) => {
    // A new invitation replaces any open one for the same address.
    await tx.query("update invitations set revoked_at = $3 where org_id = $1 and lower(email) = $2 and accepted_at is null and revoked_at is null", [
      input.orgId, email, now.toISOString(),
    ]);
    const [row] = await tx.query<{ id: string }>(
      `insert into invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [input.orgId, email, input.role, hash, input.actorId, now.toISOString(), new Date(now.getTime() + LIFETIME).toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.actorId }, action: "member.invited", entityType: "invitation", entityId: row!.id,
      data: { role: input.role }, at: now,
    });
    return row!.id;
  });
  if (!mailer) return { id, sent: false, url };
  const [ctx] = await deps.db.query<{ org: string; by: string }>(
    "select o.name as org, u.name as by from organisations o, users u where o.id = $1 and u.id = $2",
    [input.orgId, input.actorId],
  );
  await mailer.send({
    id,
    to: email,
    subject: `${ctx?.by ?? "Someone"} invited you to ${ctx?.org ?? "a workspace"} on Make Good`,
    text: [
      "Hello,",
      "",
      `${ctx?.by ?? "Someone"} invited you to join ${ctx?.org ?? "their workspace"} on Make Good as ${input.role.replace("_", " ")}.`,
      "Make Good works out which customers are owed money after a product recall and refunds them through PayPal.",
      "",
      `Accept the invitation: ${url}`,
      "",
      "The link works once and expires in 7 days. If you did not expect this, ignore it.",
    ].join("\n"),
    at: now,
  });
  return { id, sent: true, url };
}

type Open = { id: string; org_id: string; email: string; role: Role; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null };

async function byToken(deps: Deps, token: string): Promise<Open | null> {
  const [row] = await deps.db.query<Open>("select id, org_id, email, role, expires_at, accepted_at, revoked_at from invitations where token_hash = $1", [
    sha256Hex(token),
  ]);
  if (!row || row.accepted_at || row.revoked_at || new Date(row.expires_at) <= deps.clock.now()) return null;
  return row;
}

/** What the invitation page shows. Says nothing about a link that does not work. */
export async function describeInvitation(deps: Deps, token: string) {
  const row = await byToken(deps, token);
  if (!row) throw new ValidationError("This invitation is not valid any more. It may have been used, replaced or expired. Ask for a new one.");
  const [org] = await deps.db.query<{ name: string }>("select name from organisations where id = $1", [row.org_id]);
  const [account] = await deps.db.query("select 1 from users where email_normalized = $1", [row.email]);
  return { organisation: org?.name ?? "", role: row.role, email: row.email, accountExists: Boolean(account), expiresAt: row.expires_at };
}

export async function acceptInvitation(deps: Deps, input: { token: string; userId: string }): Promise<{ orgId: string; role: Role }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [row] = await tx.query<Open>(
      "select id, org_id, email, role, expires_at, accepted_at, revoked_at from invitations where token_hash = $1 for update",
      [sha256Hex(input.token)],
    );
    if (!row || row.accepted_at || row.revoked_at || new Date(row.expires_at) <= now) {
      throw new ValidationError("This invitation is not valid any more. It may have been used, replaced or expired. Ask for a new one.");
    }
    const [user] = await tx.query<{ email_normalized: string }>("select email_normalized from users where id = $1", [input.userId]);
    if (user?.email_normalized !== row.email) {
      throw new ForbiddenError(`This invitation is for ${row.email}. Sign in with that address to accept it.`);
    }
    await tx.query(
      `insert into memberships (org_id, user_id, role, created_at) values ($1, $2, $3, $4)
       on conflict (org_id, user_id) do nothing`,
      [row.org_id, input.userId, row.role, now.toISOString()],
    );
    await tx.query("update invitations set accepted_at = $2, accepted_by = $3 where id = $1", [row.id, now.toISOString(), input.userId]);
    await tx.query("update users set email_verified_at = coalesce(email_verified_at, $2) where id = $1", [input.userId, now.toISOString()]);
    await audit(tx, {
      orgId: row.org_id, actor: { kind: "user", userId: input.userId }, action: "member.joined", entityType: "invitation", entityId: row.id,
      data: { role: row.role }, at: now,
    });
    return { orgId: row.org_id, role: row.role };
  });
}

export async function listInvitations(deps: Deps, orgId: string) {
  return deps.db.query(
    `select i.id, i.email, i.role, i.created_at, i.expires_at, u.name as invited_by
       from invitations i left join users u on u.id = i.invited_by
      where i.org_id = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > $2 order by i.created_at desc`,
    [orgId, deps.clock.now().toISOString()],
  );
}

export async function revokeInvitation(deps: Deps, input: { orgId: string; id: string; actorId: string }): Promise<void> {
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    const rows = await tx.query("update invitations set revoked_at = $3 where org_id = $1 and id = $2 and accepted_at is null and revoked_at is null returning id", [
      input.orgId, input.id, now.toISOString(),
    ]);
    if (rows.length === 0) return;
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.actorId }, action: "member.invitation_revoked", entityType: "invitation", entityId: input.id,
      data: {}, at: now,
    });
  });
}
