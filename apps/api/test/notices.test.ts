// Customer emails: the batch-code request and the "you have been paid" notice.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBatch, decideBatch, startBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { answerConfirm } from "../src/modules/incidents/confirm.ts";
import { FileMailer } from "../src/modules/notify/mailer.ts";
import { emailConfirmLink, listNotices, notifyPaidCustomers } from "../src/modules/notify/notices.ts";
import { scenario } from "./scenario.ts";

const outbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "mg-outbox-"));

test("a paid customer is told once, only after PayPal confirmed, with PayPal's reference and a test label", async () => {
  const s = await scenario();
  const dir = outbox();
  const mailer = new FileMailer({ dir, from: "Kitchen Co <notices@example.com>" });
  const a = await s.sell();
  await s.sell({ batchCode: "LOT-23A" }); // not affected: never emailed
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const { id: batchId } = await createBatch(s.deps, { orgId: s.orgId, incidentId, userId: s.operator, name: "B" });
  await submitBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator });
  await decideBatch(s.deps, { orgId: s.orgId, batchId, userId: s.approver, role: "finance_approver", decision: "approve" });

  const before = await notifyPaidCustomers(s.deps, mailer, { orgId: s.orgId, incidentId, userId: s.operator });
  assert.deepEqual(before, { sent: 0, alreadyTold: 0, noEmail: 0, notConfirmedYet: 1 }, "nobody is told before PayPal confirms");

  await startBatch(s.deps, { orgId: s.orgId, batchId, userId: s.operator, spacingMs: 0 });
  await s.settle();
  const [op] = await s.operations(batchId);
  assert.equal(op!.state, "succeeded");

  const first = await notifyPaidCustomers(s.deps, mailer, { orgId: s.orgId, incidentId, userId: s.operator });
  assert.deepEqual(first, { sent: 1, alreadyTold: 0, noEmail: 0, notConfirmedYet: 0 });
  const again = await notifyPaidCustomers(s.deps, mailer, { orgId: s.orgId, incidentId, userId: s.operator });
  assert.deepEqual(again, { sent: 0, alreadyTold: 1, noEmail: 0, notConfirmedYet: 0 }, "pressing the button twice does not email twice");

  const [notice] = await listNotices(s.db, s.orgId, incidentId);
  assert.equal(notice!.to_email, a.email);
  assert.match(notice!.subject, /^\[TEST: PayPal simulator, no real money\] .*refunded USD 59\.00$/);
  assert.ok(notice!.body.includes(op!.provider_refund_id!), "the email quotes PayPal's refund reference");
  assert.ok(notice!.body.includes(a.orderNumber));

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, "one file for one email");
  const eml = fs.readFileSync(path.join(dir, files[0]!), "utf8");
  assert.match(eml, new RegExp(`^From: Kitchen Co <notices@example.com>\\r\\nTo: ${a.email.replace(/[.+]/g, "\\$&")}\\r\\n`));
  assert.equal(notice!.delivery_ref, `outbox/${files[0]}`);

  const [trail] = await s.db.query<{ n: number }>("select count(*)::int as n from audit_events where action = 'notice.payment_sent'");
  assert.equal(trail!.n, 1, "the email is on the audit trail");
});

test("a held customer is emailed a one-time link; their answer is evidence only", async () => {
  const s = await scenario();
  const dir = outbox();
  const mailer = new FileMailer({ dir, from: "Kitchen Co <notices@example.com>" });
  const a = await s.sell({ batchCode: null });
  await s.sync();
  const incidentId = await s.incident();
  await s.match(incidentId);
  const [candidate] = await s.db.query<{ id: string }>("select id from candidates where incident_id = $1 and status = 'proposed'", [incidentId]);

  const sent = await emailConfirmLink(s.deps, mailer, { orgId: s.orgId, candidateId: candidate!.id, userId: s.operator, publicUrl: "http://localhost:4000" });
  assert.equal(sent.to, a.email);
  const [notice] = await listNotices(s.db, s.orgId, incidentId);
  assert.equal(notice!.kind, "confirm_request");
  assert.ok(notice!.body.includes(sent.url), "the email carries the link");
  assert.doesNotMatch(notice!.body, /\$|USD|59/, "the email names no amount");

  const token = new URL(sent.url).searchParams.get("confirm")!;
  await answerConfirm(s.deps, { token, batchCode: "LOT-24B" });
  const [after] = await s.db.query<{ status: string }>("select status from candidates where id = $1", [candidate!.id]);
  assert.equal(after!.status, "proposed", "still waiting for a member of staff");

  await s.db.query("update candidates set customer_email = null where id = $1", [candidate!.id]);
  await assert.rejects(
    emailConfirmLink(s.deps, mailer, { orgId: s.orgId, candidateId: candidate!.id, userId: s.operator, publicUrl: "http://localhost:4000" }),
    /no email address/,
  );
});
