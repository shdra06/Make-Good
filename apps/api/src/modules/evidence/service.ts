// Incident evidence: the documents a merchant holds, what was read out of
// them, product-code aliases, and explanations of held records.
//
// The pattern in every function is the same:
//   a reader (pattern rules or Claude) proposes  ─▶  code checks the proposal
//   against the source  ─▶  a person accepts, changes or rejects it.
// Nothing a reader produces changes who is matched or paid until the person's
// step, and that step is recorded in their name.

import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { ConflictError, NotConfiguredError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import { CompensationRule } from "../compensation/engine.ts";
import { addRuleVersion, latestRuleVersion } from "../incidents/service.ts";
import { normSku, normTitle } from "../matching/engine.ts";
import { ProductScope } from "../matching/types.ts";
import { findLookalikes, type Lookalike } from "../recovery/map.ts";
import type { EvidenceAi, RecordExplanation } from "./ai.ts";
import { checkExtraction, readWithPatternRules, type Extraction } from "./extract.ts";

export type Deps = { db: Db; clock: Clock; ai: EvidenceAi | null };

const AI_MISSING = "No AI key (ANTHROPIC_API_KEY or GEMINI_API_KEY) is set for this server, so this step cannot use AI. The pattern-rule reader still works.";

export const NewDocument = z.object({
  kind: z.enum(["supplier_notice", "internal_note", "other"]).default("supplier_notice"),
  title: z.string().trim().min(2).max(200),
  body: z.string().min(20).max(60_000),
});

export async function addDocument(
  deps: Deps,
  input: { orgId: string; incidentId: string; userId: string } & z.infer<typeof NewDocument>,
): Promise<{ id: string }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const incident = await tx.query("select 1 from incidents where org_id = $1 and id = $2", [input.orgId, input.incidentId]);
    if (incident.length === 0) throw new NotFoundError("Incident");
    const [row] = await tx.query<{ id: string }>(
      `insert into incident_documents (org_id, incident_id, kind, title, body, sha256, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [input.orgId, input.incidentId, input.kind, input.title, input.body, createHash("sha256").update(input.body).digest("hex"), input.userId, now.toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "incident.document_added", entityType: "incident",
      entityId: input.incidentId, data: { documentId: row!.id, kind: input.kind, title: input.title }, at: now,
    });
    return { id: row!.id };
  });
}

export async function listEvidence(deps: Deps, orgId: string, incidentId: string) {
  const [documents, extractions] = await Promise.all([
    deps.db.query(
      "select id, kind, title, body, sha256, data_label, created_at from incident_documents where org_id = $1 and incident_id = $2 order by created_at",
      [orgId, incidentId],
    ),
    deps.db.query(
      `select e.id, e.document_id, e.method, e.model, e.output, e.warnings, e.status, e.rule_version_id, e.created_at, e.decided_at, u.name as decided_by
         from evidence_extractions e left join users u on u.id = e.decided_by
        where e.org_id = $1 and e.incident_id = $2 order by e.created_at desc`,
      [orgId, incidentId],
    ),
  ]);
  return { documents, extractions, ai: { configured: deps.ai !== null, model: deps.ai?.model ?? null } };
}

const catalogueOf = (deps: Deps, orgId: string) =>
  deps.db.query<{ sku: string; title: string | null }>("select sku, title from product_variants where org_id = $1 order by sku limit 5000", [orgId]);

/**
 * Reads a document into checked fields and stores the result as a proposal.
 * "auto" uses Claude when a key is set and the pattern rules otherwise; the
 * stored row always says which one ran.
 */
export async function extractDocument(
  deps: Deps,
  input: { orgId: string; incidentId: string; documentId: string; userId: string; method: "auto" | "pattern_rules" | "claude" | "ai" },
): Promise<{ id: string; method: "claude" | "gemini" | "pattern_rules"; model: string | null; output: Extraction }> {
  const [document] = await deps.db.query<{ body: string; title: string }>(
    "select body, title from incident_documents where org_id = $1 and incident_id = $2 and id = $3",
    [input.orgId, input.incidentId, input.documentId],
  );
  if (!document) throw new NotFoundError("Document");
  if ((input.method === "claude" || input.method === "ai") && !deps.ai) throw new NotConfiguredError("AI_NOT_CONFIGURED", AI_MISSING);
  const method: "claude" | "gemini" | "pattern_rules" = input.method === "pattern_rules" || !deps.ai ? "pattern_rules" : deps.ai.provider;
  const catalogue = await catalogueOf(deps, input.orgId);
  const skus = catalogue.map((c) => c.sku);

  let output: Extraction;
  if (method !== "pattern_rules") {
    const raw = await deps.ai!.readNotice({ document: document.body, catalogue });
    if (!raw) throw new ConflictError("AI_NO_ANSWER", "The model did not return a usable answer for this document. Use the pattern-rule reader, or enter the rules yourself.");
    output = checkExtraction(document.body, raw, skus);
  } else {
    output = checkExtraction(document.body, readWithPatternRules(document.body, skus), skus);
  }
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into evidence_extractions (org_id, incident_id, document_id, method, model, output, warnings, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) returning id`,
      [input.orgId, input.incidentId, input.documentId, method, method !== "pattern_rules" ? deps.ai!.model : null, json(output), json(output.warnings), now.toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: method !== "pattern_rules" ? { kind: "ai" } : { kind: "system" }, action: "evidence.extracted", entityType: "incident",
      entityId: input.incidentId,
      data: {
        extractionId: row!.id, documentId: input.documentId, method, model: method !== "pattern_rules" ? deps.ai!.model : null, requestedBy: input.userId,
        products: output.products.length, batchCodes: output.batchCodes.length, dropped: output.dropped.length,
      },
      at: now,
    });
    return { id: row!.id, method, model: method !== "pattern_rules" ? deps.ai!.model : null, output };
  });
}

export const AcceptExtraction = z.object({
  /** The rules as the person wants them. They may differ from what was proposed. */
  scope: ProductScope,
  compensation: CompensationRule,
  note: z.string().max(1000).optional(),
});

/**
 * A person saves rules after checking an extraction. The scope they send is
 * what is saved. One thing is refused: a batch or product code that the
 * document never mentions cannot be saved "from" that document. Add it as a
 * separate rule change instead, where it stands as the person's own entry.
 */
export async function acceptExtraction(
  deps: Deps,
  input: { orgId: string; incidentId: string; extractionId: string; userId: string } & z.infer<typeof AcceptExtraction>,
): Promise<{ ruleVersionId: string; version: number }> {
  const [row] = await deps.db.query<{ status: string; output: Extraction; title: string; method: string; body: string }>(
    `select e.status, e.output, d.title, e.method, d.body from evidence_extractions e
       join incident_documents d on d.org_id = e.org_id and d.id = e.document_id
      where e.org_id = $1 and e.incident_id = $2 and e.id = $3`,
    [input.orgId, input.incidentId, input.extractionId],
  );
  if (!row) throw new NotFoundError("Extraction");
  if (row.status !== "proposed") throw new ConflictError("ALREADY_DECIDED", `This reading was already ${row.status}.`);
  const squashed = row.body.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const absent = [...input.scope.skus, ...input.scope.batchCodes].filter((code) => !squashed.includes(code.replace(/[^a-z0-9]/gi, "").toUpperCase()));
  if (absent.length > 0) {
    throw new ValidationError(`The document does not mention ${absent.join(", ")}. Rules saved from a document can only contain codes the document names.`, { absent });
  }
  const saved = await addRuleVersion(deps, {
    orgId: input.orgId, incidentId: input.incidentId, userId: input.userId, scope: input.scope, compensation: input.compensation,
    note: input.note ?? `Read from "${row.title}" by ${row.method === "pattern_rules" ? "pattern rules" : row.method === "gemini" ? "Gemini" : "Claude"}, checked and saved by a member of staff.`,
  });
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    await tx.query(
      "update evidence_extractions set status = 'accepted', rule_version_id = $3, decided_by = $4, decided_at = $5 where org_id = $1 and id = $2",
      [input.orgId, input.extractionId, saved.id, input.userId, now.toISOString()],
    );
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "evidence.extraction_accepted", entityType: "incident",
      entityId: input.incidentId, data: { extractionId: input.extractionId, ruleVersionId: saved.id, scope: input.scope }, at: now,
    });
  });
  return { ruleVersionId: saved.id, version: saved.version };
}

// ---------- product-code aliases ----------

const DIFFERENCE_TEXT: Record<Lookalike["difference"], string> = {
  punctuation_or_case_only: "Differs from the catalogue code only by punctuation, spacing or letter case.",
  extra_characters: "Starts with the catalogue code but has extra characters. That is often a different product or a variant.",
  code_appears_in_title: "The order line has no product code. Its title contains the catalogue code.",
};

export type AliasView = {
  id: string; kind: "sku" | "title"; alias: string; canonicalSku: string; status: "suggested" | "confirmed" | "rejected";
  source: string; reason: string; lines: number; sampleTitles: string[]; batchCodes: string[];
  ai: { model: string; verdict: string; reason: string; quotedTitle: string } | null;
  decidedBy: string | null; decidedAt: Date | null;
};

/**
 * Finds order lines that look like the products in scope but are not matched,
 * stores each as a suggestion, and (when a key is set) adds Claude's opinion.
 * A suggestion changes nothing. Only `decideAlias` does.
 */
export async function suggestAliases(deps: Deps, input: { orgId: string; incidentId: string; withAi?: boolean }): Promise<{ aliases: AliasView[]; aiUsed: boolean; aiNote: string | null }> {
  const rule = await latestRuleVersion(deps.db, input.orgId, input.incidentId);
  if (!rule || rule.scope.type !== "product") {
    throw new ValidationError("Product-code aliases apply to incidents about a product. Save the incident's rules first.");
  }
  const lookalikes = await findLookalikes(deps.db, input.orgId, rule.scope.skus);
  const now = deps.clock.now();
  await deps.db.tx(async (tx) => {
    for (const l of lookalikes) {
      const normalized = l.kind === "sku" ? normSku(l.alias) : normTitle(l.alias);
      await tx.query(
        `insert into product_aliases (org_id, kind, alias, alias_normalized, canonical_sku, source, reason, evidence, line_count, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'pattern_rule', $6, $7::jsonb, $8, $9, $9)
         on conflict (org_id, kind, alias_normalized, canonical_sku) do update set
           line_count = excluded.line_count, updated_at = excluded.updated_at,
           evidence = product_aliases.evidence || jsonb_build_object('sampleTitles', excluded.evidence->'sampleTitles', 'batchCodes', excluded.evidence->'batchCodes')`,
        [input.orgId, l.kind, l.alias, normalized, l.canonicalSku, DIFFERENCE_TEXT[l.difference],
         json({ difference: l.difference, sampleTitles: l.sampleTitles, batchCodes: l.batchCodes }), l.lines, now.toISOString()],
      );
    }
  });

  let aiUsed = false;
  let aiNote: string | null = deps.ai ? null : AI_MISSING;
  if (deps.ai && input.withAi !== false) {
    const pending = await deps.db.query<{ id: string; kind: "sku" | "title"; alias: string; canonical_sku: string; evidence: { sampleTitles?: string[]; batchCodes?: string[]; ai?: unknown } }>(
      `select id, kind, alias, canonical_sku, evidence from product_aliases
        where org_id = $1 and status = 'suggested' and not (evidence ? 'ai') order by alias limit 40`,
      [input.orgId],
    );
    if (pending.length > 0) {
      const catalogue = await catalogueOf(deps, input.orgId);
      const titleOf = new Map(catalogue.map((c) => [normSku(c.sku), c.title]));
      try {
        const answer = await deps.ai.judgeAliases({
          catalogue,
          candidates: pending.map((p) => ({
            id: p.id, alias: p.alias, kind: p.kind, canonicalSku: p.canonical_sku, canonicalTitle: titleOf.get(normSku(p.canonical_sku)) ?? null,
            sampleTitles: p.evidence.sampleTitles ?? [], batchCodes: p.evidence.batchCodes ?? [],
          })),
        });
        aiUsed = answer !== null;
        if (!answer) aiNote = "The model did not return a usable answer.";
        for (const opinion of answer?.opinions ?? []) {
          const target = pending.find((p) => p.id === opinion.id);
          // An opinion must rest on a title that is really on one of the order lines.
          if (!target || !(target.evidence.sampleTitles ?? []).includes(opinion.quotedTitle)) continue;
          await deps.db.tx(async (tx) => {
            await tx.query(
              `update product_aliases set source = 'ai', model = $3, updated_at = $5,
                      evidence = evidence || jsonb_build_object('ai', $4::jsonb)
                where org_id = $1 and id = $2 and status = 'suggested'`,
              [input.orgId, target.id, deps.ai!.model,
               json({ model: deps.ai!.model, verdict: opinion.verdict, reason: opinion.reason, quotedTitle: opinion.quotedTitle }), now.toISOString()],
            );
            await audit(tx, {
              orgId: input.orgId, actor: { kind: "ai" }, action: "alias.opinion", entityType: "product_alias", entityId: target.id,
              data: { model: deps.ai!.model, verdict: opinion.verdict, alias: target.alias, canonicalSku: target.canonical_sku }, at: now,
            });
          });
        }
      } catch (err) {
        aiNote = `The model could not be reached: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  return { aliases: await listAliases(deps, input.orgId, rule.scope.skus), aiUsed, aiNote };
}

export async function listAliases(deps: Deps, orgId: string, skus: string[]): Promise<AliasView[]> {
  if (skus.length === 0) return [];
  const rows = await deps.db.query<{
    id: string; kind: "sku" | "title"; alias: string; canonical_sku: string; status: AliasView["status"]; source: string; reason: string;
    line_count: number; evidence: { sampleTitles?: string[]; batchCodes?: string[]; ai?: AliasView["ai"] }; decided_by: string | null; decided_at: Date | null;
  }>(
    `select a.id, a.kind, a.alias, a.canonical_sku, a.status, a.source, a.reason, a.line_count, a.evidence, u.name as decided_by, a.decided_at
       from product_aliases a left join users u on u.id = a.decided_by
      where a.org_id = $1 and upper(trim(a.canonical_sku)) in (${skus.map((_, i) => `$${i + 2}`).join(", ")})
      order by a.status = 'suggested' desc, a.alias`,
    [orgId, ...skus.map(normSku)],
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, alias: r.alias, canonicalSku: r.canonical_sku, status: r.status, source: r.source, reason: r.reason,
    lines: r.line_count, sampleTitles: r.evidence.sampleTitles ?? [], batchCodes: r.evidence.batchCodes ?? [], ai: r.evidence.ai ?? null,
    decidedBy: r.decided_by, decidedAt: r.decided_at,
  }));
}

/** A person confirms or rejects an alias. The match must be run again for a confirmation to take effect. */
export async function decideAlias(
  deps: Deps,
  input: { orgId: string; aliasId: string; userId: string; decision: "confirm" | "reject" },
): Promise<{ alias: string; canonicalSku: string; status: string }> {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [row] = await tx.query<{ alias: string; canonical_sku: string; status: string }>(
      `update product_aliases set status = $3, decided_by = $4, decided_at = $5, updated_at = $5
        where org_id = $1 and id = $2 returning alias, canonical_sku, status`,
      [input.orgId, input.aliasId, input.decision === "confirm" ? "confirmed" : "rejected", input.userId, now.toISOString()],
    );
    if (!row) throw new NotFoundError("Alias");
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `alias.${input.decision}`, entityType: "product_alias",
      entityId: input.aliasId, data: { alias: row.alias, canonicalSku: row.canonical_sku }, at: now,
    });
    return { alias: row.alias, canonicalSku: row.canonical_sku, status: row.status };
  });
}

// ---------- explaining a held record ----------

const maskEmails = (s: string): string => s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");

/**
 * Asks Claude to explain, from the evidence already stored, why a record is
 * waiting for a person. Points that cite nothing, or cite an id that does not
 * exist, are dropped. Customer names and emails are not sent.
 */
export async function explainCandidate(
  deps: Deps,
  input: { orgId: string; candidateId: string },
): Promise<{ model: string; explanation: RecordExplanation; dropped: number; evidence: Array<{ id: string; text: string }>; gaps: Array<{ id: string; text: string }> }> {
  if (!deps.ai) throw new NotConfiguredError("AI_NOT_CONFIGURED", AI_MISSING);
  const [candidate] = await deps.db.query<{ payment_identity: string; eligibility: string; decision: string; missing: string[] }>(
    "select payment_identity, eligibility, decision, missing from candidates where org_id = $1 and id = $2",
    [input.orgId, input.candidateId],
  );
  if (!candidate) throw new NotFoundError("Customer record");
  const rows = await deps.db.query<{ dimension: string; kind: string; strength: string; fact: string }>(
    "select dimension, kind, strength, fact from match_evidence where org_id = $1 and candidate_id = $2 order by created_at, id",
    [input.orgId, input.candidateId],
  );
  const evidence = rows.map((r, i) => ({
    id: `E${i + 1}`, about: r.dimension === "payment" ? "payment" : r.dimension === "state" ? "state of the order or payment" : "unit",
    kind: r.kind, strength: r.strength, text: maskEmails(r.fact),
  }));
  const gaps = (Array.isArray(candidate.missing) ? candidate.missing : []).map((text, i) => ({ id: `M${i + 1}`, text: maskEmails(text) }));
  const answer = await deps.ai.explainRecord({
    paymentIdentity: candidate.payment_identity, eligibility: candidate.eligibility, decision: candidate.decision, evidence, gaps,
  });
  if (!answer) throw new ConflictError("AI_NO_ANSWER", "The model did not return a usable answer. The evidence list on this record is complete without it.");
  const ids = new Set([...evidence.map((e) => e.id), ...gaps.map((g) => g.id)]);
  const cited = <T extends { cites: string[] }>(items: T[]): T[] =>
    items.map((p) => ({ ...p, cites: p.cites.filter((c) => ids.has(c)) })).filter((p) => p.cites.length > 0);
  const points = cited(answer.points);
  const contradictions = cited(answer.contradictions).filter((c) => c.cites.length >= 2);
  const dropped = answer.points.length - points.length + (answer.contradictions.length - contradictions.length);
  await deps.db.tx((tx) =>
    audit(tx, {
      orgId: input.orgId, actor: { kind: "ai" }, action: "candidate.explained", entityType: "candidate", entityId: input.candidateId,
      data: { model: deps.ai!.model, points: points.length, dropped }, at: deps.clock.now(),
    }));
  return {
    model: deps.ai.model,
    explanation: { ...answer, points, contradictions },
    dropped,
    evidence: evidence.map(({ id, text }) => ({ id, text })),
    gaps,
  };
}
