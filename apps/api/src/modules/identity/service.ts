// Accounts, sessions, organisations and roles.
//
// Sessions are random tokens. Only their hash is stored, so a copy of the
// database cannot be used to sign in. Every organisation-scoped request is
// checked against the membership table: belonging to one organisation gives
// no access to another.

import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import { DAY } from "../../platform/clock.ts";
import { DEFAULT_SCRYPT_COST, hashPassword, newToken, sha256Hex, verifyPassword, type ScryptCost } from "../../platform/crypto.ts";
import type { Db } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "../../platform/errors.ts";
import { ApprovalPolicy } from "../execution/batches.ts";

export type Deps = { db: Db; clock: Clock; passwordCost?: ScryptCost };

export const ROLES = ["owner", "admin", "finance_approver", "operator", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** What each role may do. Least privilege: a role gets only what its job needs. */
const GRANTS = {
  "org.read": ["owner", "admin", "finance_approver", "operator", "reviewer", "viewer"],
  "org.manage": ["owner", "admin"],
  "members.manage": ["owner", "admin"],
  "connections.manage": ["owner", "admin"],
  "data.import": ["owner", "admin", "operator"],
  "incident.write": ["owner", "admin", "operator"],
  "candidate.decide": ["owner", "admin", "operator", "reviewer"],
  "batch.create": ["owner", "admin", "operator"],
  "batch.approve": ["owner", "admin", "finance_approver"],
  "batch.execute": ["owner", "admin", "finance_approver", "operator"],
  "claim.review": ["owner", "admin", "operator", "reviewer"],
  "detection.manage": ["owner", "admin", "operator"],
  "audit.read": ["owner", "admin", "finance_approver"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof GRANTS;

export function can(role: Role, permission: Permission): boolean {
  return (GRANTS[permission] as readonly Role[]).includes(role);
}

export function permissionsOf(role: Role): Permission[] {
  return (Object.keys(GRANTS) as Permission[]).filter((p) => can(role, p));
}

const SESSION_DAYS = 14;
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const Credentials = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
});
export const Registration = Credentials.extend({ name: z.string().trim().min(1).max(120) });

export type SessionUser = { id: string; email: string; name: string };

export async function registerUser(deps: Deps, input: z.infer<typeof Registration>): Promise<SessionUser> {
  const email = normalizeEmail(input.email);
  const hash = await hashPassword(input.password, deps.passwordCost ?? DEFAULT_SCRYPT_COST);
  const rows = await deps.db.query<SessionUser>(
    `insert into users (email, email_normalized, name, password_hash, created_at)
     values ($1, $2, $3, $4, $5) on conflict (email_normalized) do nothing returning id, email, name`,
    [input.email.trim(), email, input.name, hash, deps.clock.now().toISOString()],
  );
  if (!rows[0]) throw new ConflictError("EMAIL_TAKEN", "An account with this email already exists.");
  return rows[0];
}

export async function signIn(
  deps: Deps,
  input: z.infer<typeof Credentials> & { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; user: SessionUser; expiresAt: Date }> {
  const rows = await deps.db.query<SessionUser & { password_hash: string; disabled_at: Date | null }>(
    "select id, email, name, password_hash, disabled_at from users where email_normalized = $1",
    [normalizeEmail(input.email)],
  );
  const user = rows[0];
  // Check a password even when the account does not exist, so the reply takes the same time either way.
  const ok = await verifyPassword(input.password, user?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  if (!user || !ok || user.disabled_at) throw new UnauthenticatedError("The email or password is not right.");
  const { token, hash } = newToken();
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY);
  await deps.db.query(
    "insert into sessions (user_id, token_hash, created_at, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5, $6)",
    [user.id, hash, now.toISOString(), expiresAt.toISOString(), input.ip ?? null, input.userAgent?.slice(0, 300) ?? null],
  );
  return { token, user: { id: user.id, email: user.email, name: user.name }, expiresAt };
}

export async function userForToken(deps: Deps, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await deps.db.query<SessionUser>(
    `select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.disabled_at is null`,
    [sha256Hex(token), deps.clock.now().toISOString()],
  );
  return rows[0] ?? null;
}

export async function signOut(deps: Deps, token: string | undefined): Promise<void> {
  if (!token) return;
  await deps.db.query("update sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null", [
    sha256Hex(token), deps.clock.now().toISOString(),
  ]);
}

// ---------- organisations ----------

export const OrgSettings = z.object({
  approval: ApprovalPolicy.default(ApprovalPolicy.parse({})),
  /** An assumed currency-conversion cost, in basis points, for forecasts only. Null hides the estimate. */
  fxAssumedSpreadBps: z.number().int().min(0).max(2000).nullable().default(null),
  /** Set when sample data was loaded, so every screen can say so. */
  demoData: z.boolean().default(false),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

export const NewOrganisation = z.object({
  name: z.string().trim().min(2).max(120),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
});

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base.length >= 2 ? base : `org-${base}`;
}

export async function createOrganisation(
  deps: Deps,
  input: z.infer<typeof NewOrganisation> & { userId: string },
): Promise<{ id: string; slug: string }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    let slug = slugify(input.name);
    const taken = await tx.query("select 1 from organisations where slug = $1", [slug]);
    if (taken.length > 0) slug = `${slug.slice(0, 34)}-${newToken(3).token.toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const [org] = await tx.query<{ id: string }>(
      "insert into organisations (name, slug, default_currency, settings, created_at) values ($1, $2, $3, $4::jsonb, $5) returning id",
      [input.name, slug, input.defaultCurrency, json(OrgSettings.parse({})), now.toISOString()],
    );
    await tx.query("insert into memberships (org_id, user_id, role, created_at) values ($1, $2, 'owner', $3)", [org!.id, input.userId, now.toISOString()]);
    await audit(tx, {
      orgId: org!.id, actor: { kind: "user", userId: input.userId }, action: "organisation.created",
      entityType: "organisation", entityId: org!.id, data: { name: input.name }, at: now,
    });
    return { id: org!.id, slug };
  });
}

export type Membership = { orgId: string; role: Role; name: string; slug: string; defaultCurrency: string; settings: OrgSettings };

export async function membershipsOf(deps: Deps, userId: string): Promise<Membership[]> {
  const rows = await deps.db.query<{ org_id: string; role: Role; name: string; slug: string; default_currency: string; settings: unknown }>(
    `select m.org_id, m.role, o.name, o.slug, trim(o.default_currency) as default_currency, o.settings
       from memberships m join organisations o on o.id = m.org_id where m.user_id = $1 order by o.name`,
    [userId],
  );
  return rows.map((r) => ({
    orgId: r.org_id, role: r.role, name: r.name, slug: r.slug, defaultCurrency: r.default_currency,
    settings: OrgSettings.parse(r.settings ?? {}),
  }));
}

/** The one gate for organisation data. Not a member: the organisation does not exist, as far as you can tell. */
export async function requireMembership(deps: Deps, userId: string, orgId: string): Promise<Membership> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new NotFoundError("Organisation");
  const all = await membershipsOf(deps, userId);
  const membership = all.find((m) => m.orgId === orgId);
  if (!membership) throw new NotFoundError("Organisation");
  return membership;
}

export function requirePermission(membership: Membership, permission: Permission): void {
  if (!can(membership.role, permission)) throw new ForbiddenError(`Your role (${membership.role}) does not allow this.`);
}

export async function listMembers(deps: Deps, orgId: string) {
  return deps.db.query<{ user_id: string; email: string; name: string; role: Role; created_at: Date }>(
    `select m.user_id, u.email, u.name, m.role, m.created_at
       from memberships m join users u on u.id = m.user_id where m.org_id = $1 order by m.created_at`,
    [orgId],
  );
}

export const MemberChange = z.object({ email: z.string().trim().email(), role: z.enum(ROLES) });

/** Adds an existing user to the organisation, or changes their role. An organisation always keeps one owner. */
export async function setMember(
  deps: Deps,
  input: z.infer<typeof MemberChange> & { orgId: string; actorId: string; actorRole: Role },
): Promise<void> {
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    const user = await tx.query<{ id: string }>("select id from users where email_normalized = $1", [normalizeEmail(input.email)]);
    if (!user[0]) throw new ValidationError("No account uses that email yet. Ask them to register first.");
    if (input.role === "owner" && input.actorRole !== "owner") throw new ForbiddenError("Only an owner can make another owner.");
    const current = await tx.query<{ role: Role }>("select role from memberships where org_id = $1 and user_id = $2 for update", [input.orgId, user[0].id]);
    if (current[0]?.role === "owner" && input.role !== "owner") {
      const [owners] = await tx.query<{ n: number }>("select count(*)::int as n from memberships where org_id = $1 and role = 'owner'", [input.orgId]);
      if ((owners?.n ?? 0) <= 1) throw new ConflictError("LAST_OWNER", "An organisation must keep at least one owner.");
    }
    await tx.query(
      `insert into memberships (org_id, user_id, role, created_at) values ($1, $2, $3, $4)
       on conflict (org_id, user_id) do update set role = excluded.role`,
      [input.orgId, user[0].id, input.role, now.toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.actorId }, action: "member.set", entityType: "user",
      entityId: user[0].id, data: { role: input.role, previousRole: current[0]?.role ?? null }, at: now,
    });
  });
}

export async function updateOrgSettings(
  deps: Deps,
  input: { orgId: string; actorId: string; patch: Partial<OrgSettings> },
): Promise<OrgSettings> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [org] = await tx.query<{ settings: unknown }>("select settings from organisations where id = $1 for update", [input.orgId]);
    if (!org) throw new NotFoundError("Organisation");
    const next = OrgSettings.parse({ ...OrgSettings.parse(org.settings ?? {}), ...input.patch });
    await tx.query("update organisations set settings = $2::jsonb where id = $1", [input.orgId, json(next)]);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.actorId }, action: "organisation.settings_changed",
      entityType: "organisation", entityId: input.orgId, data: { patch: input.patch }, at: now,
    });
    return next;
  });
}
