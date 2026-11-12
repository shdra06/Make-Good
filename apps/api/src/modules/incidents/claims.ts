// Customer claims: for recalls where the shop's records cannot find everyone.
//
// The shop opens claims on an incident and shares its public link. A customer
// fills in who they are, what they bought (order number, batch code) and why,
// and may add photos of the receipt or the product label. They get a private
// status link by email. Staff review each claim with its photos and the order
// it matches, and approve, reject or ask for more evidence. Approving never
// pays anyone: it links the claim to the customer record, where the normal
// decision and approval steps still apply.
//
// Everything the customer sends is customer data and is stored encrypted.

import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import { newToken, publicRef, sha256Hex } from "../../platform/crypto.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import type { Mailer } from "../notify/mailer.ts";

type Deps = { db: Db; clock: Clock };

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 5;

export const NewClaim = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  orderNumber: z.string().trim().max(60).optional().default(""),
  batchCode: z.string().trim().max(60).optional().default(""),
  statement: z.string().trim().min(10, "Tell us in a sentence or two what you bought and when.").max(4000),
});

export const NewEvidence = z.object({
  kind: z.enum(["receipt", "product_label", "other"]),
  name: z.string().trim().max(200).optional(),
  data: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8),
});

export const ClaimDecision = z.object({
  decision: z.enum(["approve", "reject", "needs_evidence"]),
  note: z.string().trim().max(2000).optional().default(""),
});

/** The real type of a file, from its first bytes. The name and the browser's claim are not trusted. */
function sniff(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

const statusUrl = (publicUrl: string, token: string) => `${publicUrl.replace(/\/$/, "")}/claim/status/${token}`;

async function event(q: Queryable, orgId: string, claimId: string, e: { actor: "customer" | "reviewer" | "system"; actorId?: string; kind: string; body?: string; visible: boolean; at: Date }) {
  await q.query(
    "insert into claim_events (org_id, claim_id, actor_kind, actor_id, kind, body, visible_to_customer, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [orgId, claimId, e.actor, e.actorId ?? null, e.kind, e.body ? q.pii.seal(e.body) : null, e.visible, e.at.toISOString()],
  );
}

// ---------- staff: opening claims ----------

export async function setClaimsOpen(deps: Deps, input: { orgId: string; incidentId: string; open: boolean; instructions?: string; userId: string }) {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [inc] = await tx.query<{ status: string; public_slug: string | null }>("select status, public_slug from incidents where org_id = $1 and id = $2 for update", [
      input.orgId, input.incidentId,
    ]);
    if (!inc) throw new NotFoundError("Incident");
    if (input.open && (inc.status === "closed" || inc.status === "cancelled")) throw new ConflictError("INCIDENT_CLOSED", "This incident is closed. Claims cannot be opened.");
    const slug = inc.public_slug ?? publicRef("C").toLowerCase();
    await tx.query("update incidents set claims_open = $3, public_slug = $4, claim_instructions = coalesce($5, claim_instructions), updated_at = $6 where org_id = $1 and id = $2", [
      input.orgId, input.incidentId, input.open, slug, input.instructions ?? null, now.toISOString(),
    ]);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: input.open ? "claims.opened" : "claims.closed", entityType: "incident",
      entityId: input.incidentId, data: { slug }, at: now,
    });
    return { open: input.open, slug };
  });
}

// ---------- customer ----------

async function openIncident(deps: Deps, slug: string) {
  const [inc] = await deps.db.query<{ id: string; org_id: string; title: string; claim_instructions: string | null; org: string }>(
    `select i.id, i.org_id, i.title, i.claim_instructions, o.name as org from incidents i join organisations o on o.id = i.org_id
      where i.public_slug = $1 and i.claims_open`,
    [slug.toLowerCase()],
  );
  if (!inc) throw new NotFoundError("Claim form");
  return inc;
}

export async function claimForm(deps: Deps, slug: string) {
  const inc = await openIncident(deps, slug);
  return { shop: inc.org, title: inc.title, instructions: inc.claim_instructions, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES };
}

export async function submitClaim(
  deps: Deps,
  mailer: Mailer | null,
  input: z.infer<typeof NewClaim> & { slug: string; ip: string; publicUrl: string },
): Promise<{ ref: string; token: string }> {
  const inc = await openIncident(deps, input.slug);
  const now = deps.clock.now();
  const fingerprint = sha256Hex(`claim:${input.ip}`);
  const [recent] = await deps.db.query<{ n: number }>(
    "select count(*)::int as n from claims where org_id = $1 and incident_id = $2 and claimant_email_normalized = $3",
    [inc.org_id, inc.id, deps.db.pii.emailIndex(input.email)],
  );
  if ((recent?.n ?? 0) >= 3) throw new ConflictError("TOO_MANY_CLAIMS", "This email already sent three claims for this recall. Use the status link you were emailed.");
  const { token, hash } = newToken();
  const ref = publicRef("CL");
  await deps.db.withOrg(inc.org_id, async () => {
    const [claim] = await deps.db.query<{ id: string }>(
      `insert into claims (org_id, incident_id, public_ref, access_token_hash, claimant_email, claimant_email_normalized, claimant_name, statement, declared,
                           submitter_fingerprint, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11) returning id`,
      [
        inc.org_id, inc.id, ref, hash, deps.db.pii.seal(input.email.trim()), deps.db.pii.emailIndex(input.email), deps.db.pii.seal(input.name),
        deps.db.pii.seal(input.statement), deps.db.pii.sealJson({ orderNumber: input.orderNumber, batchCode: input.batchCode }), fingerprint, now.toISOString(),
      ],
    );
    await event(deps.db, inc.org_id, claim!.id, { actor: "customer", kind: "submitted", body: "Claim received.", visible: true, at: now });
    await audit(deps.db, {
      orgId: inc.org_id, actor: { kind: "system" }, action: "claim.submitted", entityType: "claim", entityId: claim!.id, data: { ref }, at: now,
    });
  });
  if (mailer) {
    await mailer
      .send({
        id: `claim-${ref}`,
        to: input.email.trim(),
        subject: `${inc.org}: we received your claim ${ref}`,
        text: [
          `Hello ${input.name},`,
          "",
          `${inc.org} received your claim about "${inc.title}". Its reference is ${ref}.`,
          "A member of their team will look at it. You can check its status, and add photos of your receipt or the product label, here:",
          statusUrl(input.publicUrl, token),
          "",
          "Keep this email: the link is private to you.",
        ].join("\n"),
        at: now,
      })
      .catch(() => undefined);
  }
  return { ref, token };
}

async function claimByToken(deps: Deps, token: string) {
  const [claim] = await deps.db.query<{ id: string; org_id: string; incident_id: string; public_ref: string; status: string; created_at: Date }>(
    "select id, org_id, incident_id, public_ref, status, created_at from claims where access_token_hash = $1",
    [sha256Hex(token)],
  );
  if (!claim) throw new NotFoundError("Claim");
  return claim;
}

export async function claimStatus(deps: Deps, token: string) {
  const claim = await claimByToken(deps, token);
  return deps.db.withOrg(claim.org_id, async () => {
    const [inc] = await deps.db.query<{ title: string; org: string }>("select i.title, o.name as org from incidents i join organisations o on o.id = i.org_id where i.id = $1", [
      claim.incident_id,
    ]);
    const events = await deps.db.query<{ kind: string; body: string | null; created_at: Date }>(
      "select kind, body, created_at from claim_events where org_id = $1 and claim_id = $2 and visible_to_customer order by created_at",
      [claim.org_id, claim.id],
    );
    const files = await deps.db.query<{ kind: string; original_name: string | null; uploaded_at: Date }>(
      "select kind, original_name, uploaded_at from claim_evidence where org_id = $1 and claim_id = $2 order by uploaded_at",
      [claim.org_id, claim.id],
    );
    return {
      ref: claim.public_ref, status: claim.status, shop: inc?.org ?? "", title: inc?.title ?? "", submittedAt: claim.created_at, events, files,
      canAddFiles: ["submitted", "needs_evidence", "under_review"].includes(claim.status) && files.length < MAX_FILES,
    };
  });
}

export async function addEvidence(deps: Deps, input: z.infer<typeof NewEvidence> & { token: string }) {
  const claim = await claimByToken(deps, input.token);
  if (!["submitted", "needs_evidence", "under_review"].includes(claim.status)) throw new ConflictError("CLAIM_DECIDED", "This claim has been decided. Files cannot be added.");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new ValidationError("The file is larger than 4 MB. Send a smaller photo.");
  const mime = sniff(bytes);
  if (!mime) throw new ValidationError("Send a photo (JPEG, PNG or WebP) or a PDF.");
  const now = deps.clock.now();
  return deps.db.withOrg(claim.org_id, async () => {
    const [count] = await deps.db.query<{ n: number }>("select count(*)::int as n from claim_evidence where org_id = $1 and claim_id = $2", [claim.org_id, claim.id]);
    if ((count?.n ?? 0) >= MAX_FILES) throw new ConflictError("TOO_MANY_FILES", `A claim can hold ${MAX_FILES} files.`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const rows = await deps.db.query<{ id: string }>(
      `insert into claim_evidence (org_id, claim_id, kind, storage_key, original_name, mime, size_bytes, sha256, extraction_status, content, uploaded_at)
       values ($1, $2, $3, 'db', $4, $5, $6, $7, 'skipped', $8, $9) on conflict (org_id, claim_id, sha256) do nothing returning id`,
      [claim.org_id, claim.id, input.kind, input.name ? deps.db.pii.seal(input.name.slice(0, 200)) : null, mime, bytes.length, sha, deps.db.pii.seal(bytes.toString("base64")), now.toISOString()],
    );
    if (!rows[0]) return { added: false, duplicate: true };
    if (claim.status === "needs_evidence") {
      await deps.db.query("update claims set status = 'under_review', updated_at = $3 where org_id = $1 and id = $2", [claim.org_id, claim.id, now.toISOString()]);
    }
    await event(deps.db, claim.org_id, claim.id, { actor: "customer", kind: "evidence_added", body: "A file was added.", visible: true, at: now });
    return { added: true, duplicate: false };
  });
}

// ---------- staff: review ----------

export async function listClaims(q: Queryable, orgId: string, incidentId: string) {
  const rows = await q.query<{ id: string; public_ref: string; claimant_name: string; claimant_email: string; status: string; declared: unknown; created_at: Date; files: number }>(
    `select c.id, c.public_ref, c.claimant_name, c.claimant_email, c.status, c.declared, c.created_at,
            (select count(*)::int from claim_evidence e where e.org_id = c.org_id and e.claim_id = c.id) as files
       from claims c where c.org_id = $1 and c.incident_id = $2 order by (c.status in ('submitted','under_review')) desc, c.created_at desc`,
    [orgId, incidentId],
  );
  return rows.map((r) => ({ ...r, declared: typeof r.declared === "string" ? JSON.parse(r.declared) : r.declared }));
}

export async function claimDetail(q: Queryable, orgId: string, claimId: string) {
  const [claim] = await q.query<{
    id: string; incident_id: string; public_ref: string; claimant_name: string; claimant_email: string; claimant_email_normalized: string; statement: string;
    declared: unknown; status: string; candidate_id: string | null; created_at: Date;
  }>(
    "select id, incident_id, public_ref, claimant_name, claimant_email, claimant_email_normalized, statement, declared, status, candidate_id, created_at from claims where org_id = $1 and id = $2",
    [orgId, claimId],
  );
  if (!claim) throw new NotFoundError("Claim");
  const declared = (typeof claim.declared === "string" ? JSON.parse(claim.declared) : claim.declared) as { orderNumber?: string; batchCode?: string };
  const files = await q.query("select id, kind, original_name, mime, size_bytes, uploaded_at from claim_evidence where org_id = $1 and claim_id = $2 order by uploaded_at", [
    orgId, claimId,
  ]);
  const events = await q.query("select actor_kind, kind, body, visible_to_customer, created_at from claim_events where org_id = $1 and claim_id = $2 order by created_at", [
    orgId, claimId,
  ]);
  // The order it most likely refers to: the order number it names, or orders under the same email.
  const orders = await q.query<{ id: string; order_number: string; placed_at: Date; total_minor: number; currency: string; how: string }>(
    `select o.id, o.order_number, o.placed_at, o.total_minor, trim(o.currency) as currency,
            case when lower(o.order_number) = lower($3) then 'order number' else 'same email' end as how
       from orders o where o.org_id = $1 and ((nullif($3, '') is not null and lower(o.order_number) = lower($3)) or o.customer_email_normalized = $2)
      order by (lower(o.order_number) = lower($3)) desc, o.placed_at desc limit 5`,
    [orgId, claim.claimant_email_normalized, declared.orderNumber ?? ""],
  );
  const candidates = orders.length
    ? await q.query<{ id: string; order_id: string; status: string; decision: string }>(
        "select id, order_id, status, decision from candidates where org_id = $1 and incident_id = $2 and order_id = any($3::uuid[])",
        [orgId, claim.incident_id, orders.map((o) => o.id)],
      )
    : [];
  const { claimant_email_normalized: _, ...rest } = claim;
  return { ...rest, declared, files, events, matches: orders.map((o) => ({ ...o, candidate: candidates.find((c) => c.order_id === o.id) ?? null })) };
}

export async function claimFile(q: Queryable, orgId: string, claimId: string, fileId: string) {
  const [file] = await q.query<{ mime: string; content: string | null }>("select mime, content from claim_evidence where org_id = $1 and claim_id = $2 and id = $3", [
    orgId, claimId, fileId,
  ]);
  if (!file?.content) throw new NotFoundError("File");
  return { mime: file.mime, bytes: Buffer.from(file.content, "base64") };
}

export async function decideClaim(
  deps: Deps,
  mailer: Mailer | null,
  input: z.infer<typeof ClaimDecision> & { orgId: string; claimId: string; userId: string; publicUrl: string },
) {
  const now = deps.clock.now();
  const detail = await claimDetail(deps.db, input.orgId, input.claimId);
  if (["approved", "rejected", "paid", "withdrawn"].includes(detail.status)) throw new ConflictError("CLAIM_DECIDED", "This claim is already decided.");
  if (input.decision !== "approve" && !input.note) throw new ValidationError("Say why, in a sentence the customer will read.");
  const status = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "needs_evidence";
  const candidate = input.decision === "approve" ? (detail.matches.find((m) => m.candidate)?.candidate ?? null) : null;
  await deps.db.tx(async (tx) => {
    await tx.query("update claims set status = $3, candidate_id = coalesce($4, candidate_id), updated_at = $5 where org_id = $1 and id = $2", [
      input.orgId, input.claimId, status, candidate?.id ?? null, now.toISOString(),
    ]);
    const customerText =
      input.decision === "approve"
        ? `Your claim was accepted.${input.note ? ` ${input.note}` : ""} The shop will refund you through PayPal or contact you.`
        : input.decision === "reject"
          ? `Your claim was not accepted: ${input.note}`
          : `The shop needs more evidence: ${input.note} Add a photo on this page.`;
    await event(tx, input.orgId, input.claimId, {
      actor: "reviewer", actorId: input.userId, kind: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "evidence_requested",
      body: customerText, visible: true, at: now,
    });
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `claim.${input.decision}`, entityType: "claim", entityId: input.claimId,
      data: { candidateId: candidate?.id ?? null }, at: now,
    });
  });
  return { status, linkedCandidate: candidate?.id ?? null };
}

/** Tells the customer what was decided. Separate so a mail failure never undoes a decision. */
export async function emailClaimDecision(deps: Deps, mailer: Mailer | null, input: { orgId: string; claimId: string }) {
  if (!mailer) return;
  const [c] = await deps.db.query<{ public_ref: string; claimant_name: string; claimant_email: string; title: string; org: string }>(
    `select c.public_ref, c.claimant_name, c.claimant_email, i.title, o.name as org
       from claims c join incidents i on i.org_id = c.org_id and i.id = c.incident_id join organisations o on o.id = c.org_id
      where c.org_id = $1 and c.id = $2`,
    [input.orgId, input.claimId],
  );
  const [last] = await deps.db.query<{ body: string }>(
    "select body from claim_events where org_id = $1 and claim_id = $2 and visible_to_customer order by created_at desc limit 1",
    [input.orgId, input.claimId],
  );
  if (!c || !last) return;
  await mailer
    .send({
      id: `claim-${c.public_ref}-${Date.now()}`,
      to: c.claimant_email,
      subject: `${c.org}: an update on your claim ${c.public_ref}`,
      text: [`Hello ${c.claimant_name},`, "", `About "${c.title}":`, last.body, "", "Open the status link from your first email to see the details."].join("\n"),
      at: deps.clock.now(),
    })
    .catch(() => undefined);
}
