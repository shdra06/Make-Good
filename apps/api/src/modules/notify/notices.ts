// Emails to customers, in plain words:
//  - "please check the batch code on your unit" with the one-time link, for a
//    record the merchant's own data cannot settle;
//  - "you have been paid", only after PayPal confirmed the payment.
// Every email is stored in customer_notices exactly as sent. A payment is
// announced once, however often the button is pressed.

import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Db } from "../../platform/db/db.ts";
import { ConflictError, NotFoundError } from "../../platform/errors.ts";
import { formatMoney } from "../../platform/money.ts";
import { createConfirmLink } from "../incidents/confirm.ts";
import type { Mailer } from "./mailer.ts";

type Deps = { db: Db; clock: Clock };

const PREFIX: Record<string, string> = {
  simulator: "[TEST: PayPal simulator, no real money] ",
  sandbox: "[TEST: PayPal sandbox, no real money] ",
  live: "",
};

const greet = (name: string | null) => (name ? `Hello ${name.split(" ")[0]},` : "Hello,");

type Who = {
  candidate_id: string; incident_id: string; customer_email: string | null; customer_name: string | null;
  merchant: string; incident_title: string; order_number: string | null; product: string | null;
};

async function record(
  deps: Deps, mailer: Mailer,
  input: { orgId: string; userId: string; who: Who; kind: "confirm_request" | "payment_sent"; operationId?: string; subject: string; text: string },
) {
  const now = deps.clock.now();
  return deps.db.tx(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into customer_notices (org_id, incident_id, candidate_id, payment_operation_id, kind, to_email, subject, body, transport, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict do nothing returning id`,
      // The address and the letter (which greets the customer by name) are customer data.
      [input.orgId, input.who.incident_id, input.who.candidate_id, input.operationId ?? null, input.kind, tx.pii.seal(input.who.customer_email),
        input.subject, tx.pii.seal(input.text), mailer.transport, input.userId, now.toISOString()],
    );
    if (!row) return null; // this payment was already announced
    const { ref } = await mailer.send({ id: row.id, to: input.who.customer_email!, subject: input.subject, text: input.text, at: now });
    await tx.query("update customer_notices set delivery_ref = $3 where org_id = $1 and id = $2", [input.orgId, row.id, ref]);
    await audit(tx, {
      orgId: input.orgId, actor: { kind: "user", userId: input.userId }, action: `notice.${input.kind}`,
      entityType: "candidate", entityId: input.who.candidate_id, data: { noticeId: row.id, transport: mailer.transport, operationId: input.operationId ?? null }, at: now,
    });
    return { id: row.id, ref };
  });
}

const WHO_SQL = `select c.id as candidate_id, c.incident_id, c.customer_email, c.customer_name, g.name as merchant, i.title as incident_title,
                        o.order_number, l.title as product
                   from candidates c
                   join organisations g on g.id = c.org_id
                   join incidents i on i.org_id = c.org_id and i.id = c.incident_id
                   left join orders o on o.org_id = c.org_id and o.id = c.order_id
                   left join order_lines l on l.org_id = c.org_id and l.id = c.order_line_id`;

/** Makes the one-time link and emails it to the customer. */
export async function emailConfirmLink(
  deps: Deps, mailer: Mailer, input: { orgId: string; candidateId: string; userId: string; publicUrl: string },
): Promise<{ url: string; noticeId: string; to: string; ref: string }> {
  const [who] = await deps.db.query<Who>(`${WHO_SQL} where c.org_id = $1 and c.id = $2`, [input.orgId, input.candidateId]);
  if (!who) throw new NotFoundError("Record");
  if (!who.customer_email) throw new ConflictError("NO_EMAIL", "This customer has no email address on record. Copy the link and send it another way.");
  const { token } = await createConfirmLink(deps, input);
  const url = `${input.publicUrl}/confirm/${token}`;
  const product = who.product ?? "your product";
  const text = [
    greet(who.customer_name),
    "",
    `${who.merchant} is checking which customers received units from a recalled batch (${who.incident_title}).`,
    `Your order${who.order_number ? ` #${who.order_number}` : ""} included ${product}. Our records do not show which batch your unit came from.`,
    "",
    "Please open this link and type the batch code printed on your unit:",
    url,
    "",
    "The link works once. We will never ask for card details or passwords.",
    "",
    who.merchant,
  ].join("\n");
  const sent = await record(deps, mailer, {
    orgId: input.orgId, userId: input.userId, who, kind: "confirm_request",
    subject: `${who.merchant}: please check the batch code on your ${product}`, text,
  });
  return { url, noticeId: sent!.id, to: who.customer_email, ref: sent!.ref };
}

type Paid = Who & {
  operation_id: string; kind: "refund" | "payout"; amount_minor: string; currency: string;
  provider_refund_id: string | null; provider_payout_item_id: string | null; environment: string;
};

/** Emails every customer whose payment PayPal confirmed and who has not been told yet. */
export async function notifyPaidCustomers(
  deps: Deps, mailer: Mailer, input: { orgId: string; incidentId: string; userId: string },
): Promise<{ sent: number; alreadyTold: number; noEmail: number; notConfirmedYet: number }> {
  const [inc] = await deps.db.query("select 1 from incidents where org_id = $1 and id = $2", [input.orgId, input.incidentId]);
  if (!inc) throw new NotFoundError("Incident");
  const rows = await deps.db.query<Paid & { state: string; told: boolean }>(
    `select w.*, p.id as operation_id, p.kind, p.amount_minor, trim(p.currency) as currency, p.state,
            p.provider_refund_id, p.provider_payout_item_id, pc.environment,
            exists (select 1 from customer_notices n where n.org_id = p.org_id and n.payment_operation_id = p.id) as told
       from payment_operations p
       join paypal_connections pc on pc.org_id = p.org_id and pc.id = p.paypal_connection_id
       join (${WHO_SQL}) w on w.candidate_id = p.candidate_id
      where p.org_id = $1 and p.incident_id = $2
      order by p.created_at, p.id`,
    [input.orgId, input.incidentId],
  );
  const out = { sent: 0, alreadyTold: 0, noEmail: 0, notConfirmedYet: 0 };
  for (const p of rows) {
    if (p.state !== "succeeded") { if (p.state !== "cancelled" && p.state !== "failed_final") out.notConfirmedYet++; continue; }
    if (p.told) { out.alreadyTold++; continue; }
    if (!p.customer_email) { out.noEmail++; continue; }
    const amount = formatMoney(Number(p.amount_minor), p.currency);
    const ref = p.kind === "refund" ? p.provider_refund_id : p.provider_payout_item_id;
    const what = p.kind === "refund"
      ? `We have refunded ${amount} to the PayPal payment you made for it.`
      : `We have sent ${amount} to your PayPal account.`;
    const text = [
      greet(p.customer_name),
      "",
      `Your order${p.order_number ? ` #${p.order_number}` : ""}${p.product ? ` (${p.product})` : ""} is part of a recall: ${p.incident_title}.`,
      what,
      `PayPal has confirmed it${ref ? ` (PayPal reference ${ref})` : ""}. It can take a few days to show on your statement.`,
      "",
      "You do not need to do anything. We will never ask for card details or passwords.",
      "",
      p.merchant,
    ].join("\n");
    const sent = await record(deps, mailer, {
      orgId: input.orgId, userId: input.userId, who: p, kind: "payment_sent", operationId: p.operation_id,
      subject: `${PREFIX[p.environment] ?? ""}${p.merchant}: we have ${p.kind === "refund" ? "refunded" : "sent"} ${amount}`, text,
    });
    if (sent) out.sent++; else out.alreadyTold++;
  }
  return out;
}

export function listNotices(db: Db, orgId: string, incidentId: string) {
  return db.query<{ id: string; kind: string; to_email: string; subject: string; body: string; transport: string; delivery_ref: string | null; created_at: string; order_number: string | null }>(
    `select n.id, n.kind, n.to_email, n.subject, n.body, n.transport, n.delivery_ref, n.created_at, o.order_number
       from customer_notices n
       join candidates c on c.org_id = n.org_id and c.id = n.candidate_id
       left join orders o on o.org_id = c.org_id and o.id = c.order_id
      where n.org_id = $1 and n.incident_id = $2
      order by n.created_at desc, n.id`,
    [orgId, incidentId],
  );
}
