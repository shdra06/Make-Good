"use client";

import { ArrowRight, Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { HeldTable } from "@/components/incident/held-table";
import { Locked, Panel, StepIntro, Tag } from "@/components/incident/bits";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/form";
import { Alert } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day, money, moneyMap, short, time, words } from "@/lib/format";
import { useAction, useIncident } from "@/lib/incident-context";
import { BATCH_DONE, PAYMENT, UNIT } from "@/lib/labels";

const HINT = "An approval covers one exact list of payments. If anything the list rests on changes, the approval is withdrawn.";

export default function ApprovalStep() {
  const { map, preview, batch, manifest, orgUrl, incUrl, incidentId } = useIncident();
  const { run, pending } = useAction();
  const m = map.data!;
  const intro = <StepIntro question="Step 5" title="What was approved?" hint={HINT} />;

  if (!m.lastMatch || !preview.data)
    return (
      <>
        {intro}
        <Locked>Run the match first, in the Customers step.</Locked>
      </>
    );
  const pv = preview.data;
  const totalNow = Object.fromEntries(Object.entries(pv.totals.byCurrency).map(([c, v]) => [c, v.amountMinor]));
  const buildList = () =>
    run(
      () => api.post(`${incUrl}/batches`, { name: `${m.incident.title}: payment list` }),
      "Payment list built. Nothing is sent until it is approved and started.",
    );

  if (!batch.data) {
    return (
      <>
        {intro}
        <Panel title="Nothing has been approved yet" hint={`${pv.totals.count} refund(s) could go on a payment list now, totalling ${moneyMap(totalNow)}.`}>
          <h3 className="mb-2 text-sm font-semibold">Left off, and why</h3>
          <HeldTable held={pv.held} />
          <Button className="mt-4" onClick={() => void buildList()} disabled={pending || pv.totals.count === 0}>
            Build the payment list
          </Button>
        </Panel>
      </>
    );
  }

  const b = batch.data.batch;
  const versions = batch.data.manifests ?? [];
  const withdrawn = !manifest.data && versions[0]?.status === "invalidated";
  const act = (action: string, body: unknown, done: string) => run(() => api.post(`${orgUrl}/batches/${b.id}/${action}`, body), done);
  const mf = manifest.data;
  const total = mf ? mf.content.items.reduce((a, i) => a + i.amountMinor, 0) : 0;

  return (
    <>
      {intro}
      <div className="flex flex-col gap-5">
        {withdrawn ? (
          <Alert className="p-4">
            <p className="font-semibold">Version {versions[0]!.version} of this list, and any approval of it, was withdrawn.</p>
            <p>What it would pay changed after it was built:</p>
            <ul className="my-2 list-disc pl-5">
              {(versions[0]!.invalidated_reason ?? []).slice(0, 6).map((r) => (
                <li key={r.detail}>{r.detail}</li>
              ))}
            </ul>
            <Button
              variant="outline"
              onClick={() => void act("revise", {}, "A new version of the list was built. It needs a new approval.")}
              disabled={pending}
            >
              Build a new version of the list
            </Button>
          </Alert>
        ) : null}

        {mf ? (
          <Panel
            title={`Payment list, version ${mf.version}`}
            hint={`${mf.content.items.length} payments · ${money(total, mf.content.items[0]?.currency ?? "USD")}`}
            actions={
              <>
                <Tag tone={["approved", "completed"].includes(b.status) ? "ok" : b.status === "completed_with_failures" ? "stop" : "info"}>
                  {words(b.status)}
                </Tag>
                <Button asChild size="sm" variant="outline">
                  <a href={`${orgUrl}/batches/${b.id}/manifest?format=csv`}>
                    <Download /> Export CSV
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={`${orgUrl}/batches/${b.id}/manifest`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink /> Open JSON
                  </a>
                </Button>
              </>
            }
          >
            <p className="mb-3 font-mono text-xs break-all text-muted-foreground" data-testid="manifest-hash">
              sha-256 {mf.contentHash} · built {day(mf.content.createdAt)} {time(mf.content.createdAt)} by {mf.content.createdBy.name} · rules version{" "}
              {mf.content.rule.version} · PayPal: {mf.content.environment}
            </p>
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Why payable</th>
                    <th>Refund to PayPal payment</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {mf.content.items.map((i) => (
                    <tr key={i.n}>
                      <td className="text-muted-foreground tabular-nums">{i.n}</td>
                      <td className="font-mono">{i.orderNumber}</td>
                      <td>{i.customerName}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          <Tag tone={PAYMENT[i.paymentIdentity].tone}>{PAYMENT[i.paymentIdentity].label}</Tag>
                          <Tag tone={UNIT[i.eligibility].tone}>{UNIT[i.eligibility].label}</Tag>
                        </div>
                        {i.confirmedBy ? (
                          <p className="text-xs text-muted-foreground">
                            confirmed by {i.confirmedBy}: {words(i.confirmationBasis ?? "no basis recorded")}
                          </p>
                        ) : null}
                      </td>
                      <td className="font-mono text-xs">{i.captureId ?? i.recipient}</td>
                      <td className="text-right tabular-nums">{money(i.amountMinor, i.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <h3 className="mt-5 mb-2 text-sm font-semibold">Left off this list · {mf.content.notIncluded.length}</h3>
            <HeldTable held={mf.content.notIncluded} />
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {b.status === "draft" ? (
                <Button onClick={() => void act("submit", {}, "Sent for approval.")} disabled={pending}>
                  Send for approval
                </Button>
              ) : null}
              {b.status === "pending_approval" ? (
                <>
                  <Button
                    onClick={() =>
                      void act(
                        "decision",
                        { decision: "approve", comment: "Checked against the list." },
                        "Approved. The approval covers this version of the list and no other.",
                      )
                    }
                    disabled={pending}
                  >
                    Approve exactly this list (version {mf.version})
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => void act("decision", { decision: "reject" }, "Rejected. Nobody will be paid from this list.")}
                    disabled={pending}
                  >
                    Reject
                  </Button>
                  <span className="text-sm text-muted-foreground">In a real team a second person approves. This demo account has one user.</span>
                </>
              ) : null}
              {b.status === "approved" ? (
                <Button asChild>
                  <Link href={`/incidents/${incidentId}/payments`}>
                    Go to payments <ArrowRight />
                  </Link>
                </Button>
              ) : null}
            </div>
          </Panel>
        ) : null}

        {versions.length > 0 ? (
          <Panel title="Versions and approvals">
            <Table>
              <tbody>
                {versions.map((v) => (
                  <tr key={`v${v.version}`}>
                    <td>Version {v.version}</td>
                    <td>
                      <Tag tone={v.status === "current" ? "ok" : v.status === "invalidated" ? "stop" : "neutral"}>
                        {v.status === "current" ? "in force" : v.status}
                      </Tag>
                    </td>
                    <td className="font-mono text-xs">{short(v.content_hash, 16)}</td>
                    <td className="text-xs text-muted-foreground">
                      {v.item_count} payments · built {time(v.created_at)} by {v.created_by ?? "–"}
                    </td>
                  </tr>
                ))}
                {(batch.data.approvals ?? []).map((a, i) => (
                  <tr key={`a${i}`}>
                    <td>{a.decision === "approve" ? "Approved" : "Rejected"}</td>
                    <td>{a.name}</td>
                    <td className="font-mono text-xs">{short(a.manifest_hash, 16)}</td>
                    <td className="text-xs text-muted-foreground">
                      version {a.manifest_version ?? "–"} · {time(a.created_at)}
                      {a.comment ? ` · “${a.comment}”` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        ) : null}

        {BATCH_DONE.includes(b.status) && pv.totals.count > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">{pv.totals.count} more record(s) became payable.</span>
            <Button variant="outline" onClick={() => void buildList()} disabled={pending}>
              Build another payment list
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
