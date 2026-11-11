// A link a merchant can send to one customer, asking for the batch code
// printed on their unit.
//
// What the customer types is stored as evidence, in their words, and nothing
// else changes: the record stays held. A member of staff then sees the answer
// next to the other evidence and decides. A customer's statement never makes
// a record payable by itself.

import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import { newToken, sha256Hex } from "../../platform/crypto.ts";
import type { Db } from "../../platform/db/db.ts";
import { ConflictError, NotFoundError } from "../../platform/errors.ts";
import { normCode } from "../matching/engine.ts";

type Deps = { db: Db; clock: Clock };

/** Creates (or replaces) the link for one held record. The token is returned once and only its hash is stored. */
export async function createConfirmLink(deps: Deps, input: { orgId: string; candidateId: string; userId: string }): Promise<{ token: string }> {
  const { token, hash } = newToken(24);
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const rows = await tx.query<{ incident_id: string }>(
      `update candidates set confirm_token_hash = $3, updated_at = $4
        where org_id = $1 and id = $2 and status = 'proposed' and order_line_id is not null returning incident_id`,
      [input.orgId, input.candidateId, hash, now.toISOString()],
    );
    if (!rows[0]) throw new ConflictError("NOT_WAITING", "A link can only be made for a record that is waiting for a decision and has an order.");
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: "candidate.confirm_link_created",
      entityType: "candidate", entityId: input.candidateId, data: {}, at: now,
    });
    return { token };
  });
}

type Asked = {
  id: string; org_id: string; incident_id: string; status: string; merchant: string; incident_title: string;
  order_number: string | null; line_title: string | null; scope: { batchCodes?: string[] } | null;
};

async function find(deps: Deps, token: string): Promise<Asked> {
  const rows = await deps.db.query<Asked>(
    `select c.id, c.org_id, c.incident_id, c.status, g.name as merchant, i.title as incident_title, o.order_number, l.title as line_title,
            (select r.scope from incident_rule_versions r where r.org_id = c.org_id and r.incident_id = c.incident_id order by r.version desc limit 1) as scope
       from candidates c
       join organisations g on g.id = c.org_id
       join incidents i on i.org_id = c.org_id and i.id = c.incident_id
       left join orders o on o.org_id = c.org_id and o.id = c.order_id
       left join order_lines l on l.org_id = c.org_id and l.id = c.order_line_id
      where c.confirm_token_hash = $1`,
    [sha256Hex(token)],
  );
  if (!rows[0]) throw new NotFoundError("This link");
  return rows[0];
}

/** What the customer sees. No email, no amount, no other customer's data. */
export async function confirmQuestion(deps: Deps, token: string) {
  const c = await find(deps, token);
  return { merchant: c.merchant, incident: c.incident_title, orderNumber: c.order_number, product: c.line_title };
}

/** Stores the customer's answer as evidence and uses up the link. */
export async function answerConfirm(deps: Deps, input: { token: string; batchCode: string }): Promise<{ received: true }> {
  const c = await find(deps, input.token);
  const now = deps.clock.now();
  const typed = input.batchCode.trim().slice(0, 60);
  const affected = (c.scope?.batchCodes ?? []).map(normCode);
  const matches = affected.includes(normCode(typed));
  await deps.db.tx(async (tx) => {
    await tx.query(
      `insert into match_evidence (org_id, candidate_id, source, record_id, fact, strength, dimension, kind, created_at)
       values ($1, $2, 'customer_statement', null, $3, $4, 'eligibility', 'fact', $5)`,
      [
        c.org_id, c.id,
        `The customer entered the batch code "${typed}" from their unit on ${now.toISOString().slice(0, 10)}, through the link sent to them. ${matches ? "It is an affected batch." : "It is not one of the affected batches."} This is the customer's statement, not a record.`,
        matches ? "supports" : "contradicts", now.toISOString(),
      ],
    );
    await tx.query("update candidates set confirm_token_hash = null, updated_at = $3 where org_id = $1 and id = $2", [c.org_id, c.id, now.toISOString()]);
    await audit(tx, {
      orgId: c.org_id, actor: { kind: "customer" }, action: "candidate.customer_answered", entityType: "candidate", entityId: c.id,
      data: { batchCode: typed, matchesAffectedBatch: matches }, at: now,
    });
  });
  return { received: true };
}
