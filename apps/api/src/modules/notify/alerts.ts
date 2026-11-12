// Staff alerts: emails to the people who must act.
//
//   batch.submitted   a payment list waits for approval   -> roles that may approve
//   batch.finished    PayPal has answered for every payment -> owners, admins, the list's builder
//   detection.raised  a new critical finding                -> owners and admins
//
// The event queues a job in the same transaction that makes it true (queueAlert),
// so an alert is never lost and never sent for something that was rolled back.
// The job writes each email to `notifications` before sending, once per person.

import type { Clock } from "../../platform/clock.ts";
import type { Db, Queryable } from "../../platform/db/db.ts";
import { enqueue, type Job } from "../../platform/jobs/queue.ts";
import type { Mailer } from "./mailer.ts";

export type Alert =
  | { kind: "batch.submitted"; batchId: string }
  | { kind: "batch.finished"; batchId: string }
  | { kind: "detection.raised"; detectionId: string };

export async function queueAlert(tx: Queryable, orgId: string, alert: Alert, now: Date): Promise<void> {
  const subject = "batchId" in alert ? alert.batchId : alert.detectionId;
  await enqueue(tx, { type: "staff.alert", orgId, payload: alert, dedupeKey: `alert:${alert.kind}:${subject}` }, now);
}

type Message = { roles: string[]; extraUserIds?: string[]; subject: string; lines: string[]; related: Record<string, string> };

async function compose(q: Queryable, orgId: string, alert: Alert, publicUrl: string): Promise<Message | null> {
  const [org] = await q.query<{ name: string }>("select name from organisations where id = $1", [orgId]);
  const shop = org?.name ?? "your workspace";
  if (alert.kind === "detection.raised") {
    const [d] = await q.query<{ title: string; summary: string; severity: string }>("select title, summary, severity from detections where org_id = $1 and id = $2", [
      orgId, alert.detectionId,
    ]);
    if (!d || d.severity !== "critical") return null;
    return {
      roles: ["owner", "admin"],
      subject: `[${shop}] Needs attention: ${d.title}`,
      lines: [d.summary, "", `Open Monitoring: ${publicUrl}/monitoring`],
      related: { detectionId: alert.detectionId },
    };
  }
  const [b] = await q.query<{ name: string; status: string; incident_id: string; created_by: string | null; ok: number; failed: number; unknown: number }>(
    `select b.name, b.status, b.incident_id, b.created_by,
            count(op.id) filter (where op.state = 'succeeded')::int as ok,
            count(op.id) filter (where op.state = 'failed_final')::int as failed,
            count(op.id) filter (where op.state not in ('succeeded','failed_final','cancelled'))::int as unknown
       from batches b left join payment_operations op on op.org_id = b.org_id and op.batch_id = b.id
      where b.org_id = $1 and b.id = $2 group by b.id`,
    [orgId, alert.batchId],
  );
  if (!b) return null;
  const link = `${publicUrl}/incidents/${b.incident_id}/${alert.kind === "batch.submitted" ? "approval" : "payments"}`;
  if (alert.kind === "batch.submitted") {
    if (b.status !== "pending_approval") return null; // already decided
    return {
      roles: ["owner", "admin", "finance_approver"],
      subject: `[${shop}] A payment list waits for your approval: ${b.name}`,
      lines: ["A payment list was submitted for approval. Nothing is paid until it is approved.", "", `Review it: ${link}`],
      related: { batchId: alert.batchId },
    };
  }
  return {
    roles: ["owner", "admin"],
    extraUserIds: b.created_by ? [b.created_by] : [],
    subject: `[${shop}] Payments ${b.failed > 0 ? "finished with failures" : "finished"}: ${b.name}`,
    lines: [
      `PayPal confirmed ${b.ok} payment${b.ok === 1 ? "" : "s"}.${b.failed ? ` ${b.failed} failed.` : ""}${b.unknown ? ` ${b.unknown} still unknown.` : ""}`,
      "",
      `See the results: ${link}`,
    ],
    related: { batchId: alert.batchId },
  };
}

export async function sendAlert(deps: { db: Db; clock: Clock; mailer: Mailer | null; publicUrl: string }, job: Job): Promise<void> {
  const orgId = job.org_id!;
  const alert = job.payload as Alert;
  const message = await compose(deps.db, orgId, alert, deps.publicUrl);
  if (!message || !deps.mailer) return;
  const people = await deps.db.query<{ email: string; name: string }>(
    `select distinct u.email, u.name from memberships m join users u on u.id = m.user_id
      where m.org_id = $1 and u.disabled_at is null and (m.role = any($2::text[]) or u.id = any($3::uuid[]))`,
    [orgId, message.roles, message.extraUserIds ?? []],
  );
  for (const person of people) {
    const already = await deps.db.query(
      "select 1 from notifications where org_id = $1 and template = $2 and to_address = $3 and related = $4::jsonb and status = 'sent'",
      [orgId, alert.kind, person.email, JSON.stringify(message.related)],
    );
    if (already.length > 0) continue; // a retried job does not email anyone twice
    const text = [`Hello ${person.name},`, "", ...message.lines, "", "You get this email because of your role in this Make Good workspace."].join("\n");
    const [row] = await deps.db.query<{ id: string }>(
      `insert into notifications (org_id, channel, template, to_address, subject, body_text, related, status, transport, created_at)
       values ($1, 'email', $2, $3, $4, $5, $6::jsonb, 'queued', $7, $8) returning id`,
      [orgId, alert.kind, person.email, message.subject, text, JSON.stringify(message.related), deps.mailer.transport, deps.clock.now().toISOString()],
    );
    try {
      const { ref } = await deps.mailer.send({ id: row!.id, to: person.email, subject: message.subject, text, at: deps.clock.now() });
      await deps.db.query("update notifications set status = 'sent', provider_message_id = $2, sent_at = $3 where id = $1", [row!.id, ref, deps.clock.now().toISOString()]);
    } catch (err) {
      await deps.db.query("update notifications set status = 'failed', error = $2 where id = $1", [row!.id, err instanceof Error ? err.message : String(err)]);
      throw err; // the job is retried; people already emailed are skipped
    }
  }
}
