"use client";

import { Mail } from "lucide-react";
import { toast } from "sonner";
import { Locked, Panel, Stat, StepIntro, Tag } from "@/components/incident/bits";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/form";
import { api } from "@/lib/api";
import { day, money, time, words } from "@/lib/format";
import { useAction, useIncident } from "@/lib/incident-context";
import { BATCH_STARTED, opLabel } from "@/lib/labels";
import type { Evaluation } from "@/lib/types";

function Results({ e }: { e: Extract<Evaluation, { available: true }> }) {
  const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
  return (
    <Panel title="Checked against the known answers" hint={e.basis}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="results">
        <Stat value={`${e.eligibility.correct} of ${e.eligibility.truthAffectedUnits}`} label="affected units proven from records alone" />
        <Stat value={e.eligibility.wrongInclusions} label="units called proven that were not affected" />
        <Stat
          value={e.eligibility.heldAffected + e.eligibility.heldNotAffected}
          label={`units held for a person (${e.eligibility.heldAffected} truly affected, ${e.eligibility.heldNotAffected} not)`}
        />
        <Stat value={e.eligibility.missed} label="affected units missed" />
        <Stat value={pct(e.eligibility.precision)} label="precision of “proven”" />
        <Stat value={e.payment.falseMatches} label={`payments tied to the wrong order (${e.payment.verifiedAndRight} right, ${e.payment.held} held)`} />
        <Stat
          value={`${e.money.linesPaid - e.money.overpaidLines - e.money.underpaidLines} of ${e.money.linesPaid}`}
          label="paid lines that received exactly what was owed"
        />
        <Stat value={e.duplicates.paymentsRefundedTwiceInThisIncident + e.money.paidToUnaffected} label="double refunds, or refunds to unaffected customers" />
      </div>
    </Panel>
  );
}

export default function PaymentsStep() {
  const { batch, manifest, map, reconciliation, notices, evaluation, orgUrl, incUrl } = useIncident();
  const { run, pending } = useAction();
  const intro = <StepIntro question="Step 6" title="What actually happened?" hint="PayPal's answer, not ours." />;

  if (!batch.data)
    return (
      <>
        {intro}
        <Locked>Nothing has been sent. Build and approve a payment list first.</Locked>
      </>
    );

  const b = batch.data.batch;
  const ops = batch.data.operations;
  const sim = map.data!.dataLabels.paypal === "simulator";
  const started = BATCH_STARTED.includes(b.status);
  const first = manifest.data?.content.items[0];
  const fault = (body: unknown) =>
    run(async () => {
      const r = await api.post<{ staged: string }>(`${orgUrl}/demo/faults`, body);
      toast.info(r.staged);
    });
  const counts = new Map<string, { n: number; tone: ReturnType<typeof opLabel>["tone"] }>();
  ops.forEach((o) => {
    const l = opLabel(o);
    counts.set(l.label, { n: (counts.get(l.label)?.n ?? 0) + 1, tone: l.tone });
  });
  const mine = (reconciliation.data ?? []).filter((r) => r.batch_id === b.id);
  const paidAny = ops.some((o) => o.state === "succeeded");
  const mails = notices.data?.items ?? [];

  const notifyPaid = () =>
    run(
      () => api.post<{ sent: number; alreadyTold: number; noEmail: number; notConfirmedYet: number }>(`${incUrl}/notices/paid`),
      (r) => {
        const parts = [`${r.sent} emailed`];
        if (r.alreadyTold) parts.push(`${r.alreadyTold} already told`);
        if (r.noEmail) parts.push(`${r.noEmail} with no email address`);
        if (r.notConfirmedYet) parts.push(`${r.notConfirmedYet} not confirmed by PayPal yet, so not told`);
        return `${parts.join(", ")}.`;
      },
    );

  return (
    <>
      {intro}
      <div className="flex flex-col gap-5">
        {b.status === "approved" ? (
          <Panel
            title="Ready to pay"
            hint="Each payment is checked against the approved list once more, just before it is sent to PayPal."
            actions={
              <Button
                onClick={() =>
                  void run(
                    () => api.post(`${orgUrl}/batches/${b.id}/start`, {}),
                    "Started. Each payment is checked against the approved list once more before it is sent.",
                  )
                }
                disabled={pending}
              >
                Start paying
              </Button>
            }
          >
            {sim && first ? (
              <div className="rounded-lg border border-dashed p-4">
                <h3 className="text-sm font-semibold">Make something go wrong (simulator only)</h3>
                <p className="mb-3 text-sm text-muted-foreground">
                  Two things that happen with real payments. Stage either before you start paying, and watch what the system does.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void fault({ kind: "lose_next_reply" })} disabled={pending}>
                    Lose one reply from PayPal
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void fault({ kind: "refund_elsewhere", captureId: first.captureId })} disabled={pending}>
                    Refund {first.orderNumber} in the PayPal dashboard first
                  </Button>
                </div>
              </div>
            ) : null}
          </Panel>
        ) : null}

        {!started ? (
          b.status !== "approved" ? (
            <Locked>Nothing has been sent. Payments start only after the list is approved.</Locked>
          ) : null
        ) : (
          <Panel
            title="Each payment, as PayPal reports it"
            actions={
              <>
                {[...counts.entries()].map(([label, { n, tone }]) => (
                  <Tag key={label} tone={tone}>
                    {n} {label.charAt(0).toLowerCase() + label.slice(1)}
                  </Tag>
                ))}
                {b.paused_reason ? <Tag tone="hold">paused: {b.paused_reason}</Tag> : null}
              </>
            }
          >
            <div className="max-h-[28rem] overflow-y-auto" data-testid="operations">
              <Table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th className="text-right">Amount</th>
                    <th>Status</th>
                    <th>PayPal refund ID</th>
                    <th className="text-right">Calls</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.map((o) => {
                    const l = opLabel(o);
                    return (
                      <tr key={o.id}>
                        <td className="font-mono">{o.order_number}</td>
                        <td>{o.customer_name}</td>
                        <td className="text-right tabular-nums">{money(o.amount_minor, o.currency)}</td>
                        <td>
                          <Tag tone={l.tone}>{l.label}</Tag>
                        </td>
                        <td className="font-mono text-xs">{o.provider_refund_id ?? "–"}</td>
                        <td className="text-right tabular-nums">{o.attempts}</td>
                        <td className="max-w-xs text-xs">
                          {o.failure_message
                            ? `${o.failure_code}: ${o.failure_message}`
                            : o.attempts > 1 && o.state === "succeeded"
                              ? "The first reply was lost. Asked again with the same request ID; PayPal returned the same refund."
                              : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              A payment shows as paid only when PayPal&apos;s own record says so. A failed refund stays failed: it is never sent some other way without a new
              decision by a person.
            </p>
          </Panel>
        )}

        {started && mine.length > 0 ? (
          <Panel title="Differences found and how they were settled">
            {mine.map((r, i) => (
              <div key={i} className="flex gap-3 border-t py-2 text-sm first:border-t-0">
                <Tag tone={r.status === "resolved" ? "ok" : "stop"}>{r.status}</Tag>
                <div>
                  <p className="font-medium">{words(r.kind)}</p>
                  <p className="text-muted-foreground">{r.resolution ?? "Open: a person is needed."}</p>
                </div>
              </div>
            ))}
          </Panel>
        ) : null}

        {started && (paidAny || mails.length > 0) ? (
          <Panel
            title="What customers were told"
            hint="A customer is told they were paid only after PayPal confirmed the payment, and only once. Emails are saved as files in the outbox; nothing is sent over the internet yet."
            actions={
              <>
                <Tag>{mails.length ? `${mails.length} emails` : "no emails yet"}</Tag>
                {paidAny ? (
                  <Button size="sm" onClick={() => void notifyPaid()} disabled={pending}>
                    <Mail /> Email the customers PayPal has paid
                  </Button>
                ) : null}
              </>
            }
          >
            <div className="flex flex-col gap-2" data-testid="notices">
              {mails.map((n) => (
                <details key={n.id} className="rounded-lg border p-3">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <Tag tone={n.kind === "payment_sent" ? "ok" : "hold"}>{n.kind === "payment_sent" ? "paid" : "asked for batch code"}</Tag>
                    <span className="font-mono">{n.order_number ? `#${n.order_number}` : ""}</span>
                    <span>{n.subject}</span>
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    To {n.to_email}, {day(n.created_at)} {time(n.created_at)}, saved as {n.delivery_ref ?? "?"}
                  </p>
                  <pre className="mt-2 rounded-md bg-muted p-3 font-sans text-sm whitespace-pre-wrap">{n.body}</pre>
                </details>
              ))}
            </div>
          </Panel>
        ) : null}

        {started && evaluation.data?.available ? <Results e={evaluation.data} /> : null}
      </div>
    </>
  );
}
