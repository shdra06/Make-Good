// Invitations by email, and alerts to the staff who must act.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { acceptInvitation, describeInvitation, invite, listInvitations, revokeInvitation } from "../src/modules/identity/invitations.ts";
import { registerUser } from "../src/modules/identity/service.ts";
import { sendAlert } from "../src/modules/notify/alerts.ts";
import type { Email, Mailer } from "../src/modules/notify/mailer.ts";
import type { Job } from "../src/platform/jobs/queue.ts";
import { scenario } from "./scenario.ts";

const memoryMailer = () => {
  const sent: Email[] = [];
  const mailer: Mailer = { transport: "file", send: async (e) => (sent.push(e), { ref: `mem/${e.id}` }) };
  return { sent, mailer };
};
const tokenIn = (e: Email) => e.text.split("/invite/")[1]!.split(/\s/)[0]!;

test("an invitation by email: works once, only for that address, and can be withdrawn", async () => {
  const s = await scenario();
  const deps = { db: s.db, clock: s.clock, passwordCost: { N: 1024, r: 8, p: 1 } };
  const { sent, mailer } = memoryMailer();
  const base = { orgId: s.orgId, actorId: s.approver, publicUrl: "http://app.test" };

  await assert.rejects(invite(deps, mailer, { ...base, actorRole: "admin", email: "x@example.com", role: "owner" }), /Only an owner/);
  await assert.rejects(invite(deps, mailer, { ...base, actorRole: "owner", email: "OLIVE@kitchen.test", role: "viewer" }), /already in the team/);

  const out = await invite(deps, mailer, { ...base, actorRole: "admin", email: "Nia@Example.com", role: "reviewer" });
  assert.equal(out.sent, true);
  assert.equal(sent.at(-1)!.to, "nia@example.com");
  const token = tokenIn(sent.at(-1)!);
  assert.equal((await s.db.query("select 1 from invitations where token_hash = $1", [token])).length, 0, "only the hash is stored");
  const seen = await describeInvitation(deps, token);
  assert.deepEqual([seen.organisation, seen.role, seen.email, seen.accountExists], ["Kitchen Co", "reviewer", "nia@example.com", false]);

  const stranger = await registerUser(deps, { email: "someone@example.com", password: "correct horse battery", name: "Someone" });
  await assert.rejects(acceptInvitation(deps, { token, userId: stranger.id }), /is for nia@example.com/, "a forwarded link is no use to anyone else");
  const nia = await registerUser(deps, { email: "nia@example.com", password: "correct horse battery", name: "Nia" });
  assert.deepEqual(await acceptInvitation(deps, { token, userId: nia.id }), { orgId: s.orgId, role: "reviewer" });
  const [m] = await s.db.query<{ role: string }>("select role from memberships where org_id = $1 and user_id = $2", [s.orgId, nia.id]);
  assert.equal(m!.role, "reviewer");
  const [v] = await s.db.query<{ v: Date | null }>("select email_verified_at as v from users where id = $1", [nia.id]);
  assert.ok(v!.v, "accepting proves the email address");
  await assert.rejects(acceptInvitation(deps, { token, userId: nia.id }), /not valid any more/, "it works once");

  await invite(deps, mailer, { ...base, actorRole: "admin", email: "kai@example.com", role: "viewer" });
  const kaiToken = tokenIn(sent.at(-1)!);
  const [pending] = (await listInvitations(deps, s.orgId)) as { id: string }[];
  await revokeInvitation(deps, { orgId: s.orgId, id: pending!.id, actorId: s.approver });
  await assert.rejects(describeInvitation(deps, kaiToken), /not valid any more/);

  await invite(deps, mailer, { ...base, actorRole: "admin", email: "lee@example.com", role: "viewer" });
  const leeToken = tokenIn(sent.at(-1)!);
  s.clock.advance(8 * 24 * 60 * 60_000);
  await assert.rejects(describeInvitation(deps, leeToken), /not valid any more/, "expires after 7 days");
});

test("a payment list waiting for approval emails the people who may approve it, once", async () => {
  const s = await scenario();
  await s.sell({ batchCode: "LOT-24B" });
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "Refunds" });
  await submitBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });

  const jobs = await s.db.query<Job>("select id, org_id, type, payload, attempts, max_attempts, run_at from jobs where type = 'staff.alert'");
  assert.equal(jobs.length, 1, "queued in the same transaction as the submission");
  const { sent, mailer } = memoryMailer();
  const deps = { db: s.db, clock: s.clock, mailer, publicUrl: "http://app.test" };
  await sendAlert(deps, jobs[0]!);
  assert.deepEqual(sent.map((e) => e.to), ["ada@kitchen.test"], "the finance approver, not the operator who built it");
  assert.match(sent[0]!.subject, /waits for your approval: Refunds/);
  assert.match(sent[0]!.text, new RegExp(`http://app.test/incidents/${incidentId}/approval`));
  await sendAlert(deps, jobs[0]!);
  assert.equal(sent.length, 1, "a retried job does not email anyone twice");
  const [n] = await s.db.query<{ status: string }>("select status from notifications where org_id = $1", [s.orgId]);
  assert.equal(n!.status, "sent");
});
