"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Panel, Stat } from "@/components/incident/bits";
import { PageHeader } from "@/components/page-header";
import { Table } from "@/components/ui/form";
import { Alert } from "@/components/ui/primitives";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { money, words } from "@/lib/format";
import { orgPath, useOrg } from "@/lib/session";

type Analytics = {
  byIncident: { id: string; title: string; kind: string; status: string; affected: number; paid: number; paid_minor: number }[];
  outcomes: { kind: string; state: string; currency: string; n: number; amount_minor: number }[];
  timing: { id: string; name: string; seconds_to_approval: number | null; seconds_to_finish: number | null }[];
  failures: { failure_code: string; n: number }[];
};

const duration = (s: number | null) =>
  s === null ? "–" : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`;

const STATE_TONE: Record<string, string> = { succeeded: "bg-ok", failed_final: "bg-destructive", unknown: "bg-hold", pending_provider: "bg-info" };

export default function AnalyticsPage() {
  const org = useOrg();
  const data = useQuery({ queryKey: ["analytics", org?.orgId], queryFn: () => api.get<Analytics>(orgPath(org!, "/analytics")), enabled: org !== null });
  if (!org) return null;
  const currency = org.defaultCurrency;

  if (data.isPending)
    return (
      <>
        <PageHeader title="Analytics" />
        <div className="mb-6 grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <TableSkeleton />
      </>
    );
  if (data.isError) return <Alert>{data.error.message}</Alert>;

  const { byIncident, outcomes, timing, failures } = data.data;
  const ops = outcomes.reduce((n, o) => n + o.n, 0);
  const paid = outcomes.filter((o) => o.state === "succeeded");
  const paidMinor = paid.filter((o) => o.currency === currency).reduce((n, o) => n + Number(o.amount_minor), 0);
  const paidCount = paid.reduce((n, o) => n + o.n, 0);
  const approvals = timing.map((t) => t.seconds_to_approval).filter((s): s is number => s !== null);
  const median = approvals.length ? [...approvals].sort((a, b) => a - b)[Math.floor(approvals.length / 2)]! : null;
  const byState = Object.entries(outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o.state]: (m[o.state] ?? 0) + o.n }), {}));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="How recalls and refunds went: how many were owed, how many PayPal paid, how long it took, and why payments failed."
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat value={byIncident.length} label="Incidents" />
        <Stat value={paidCount} label="Payments confirmed by PayPal" tone="text-ok" />
        <Stat value={money(paidMinor, currency)} label={`Paid back (${currency})`} />
        <Stat value={duration(median)} label="Median time to approval" />
      </div>
      <div className="flex flex-col gap-6">
        <Panel title="By incident" testId="by-incident">
          {byIncident.length === 0 ? (
            <p className="text-sm text-muted-foreground">No incidents yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Status</th>
                  <th className="text-right">Affected</th>
                  <th className="text-right">Paid</th>
                  <th>Progress</th>
                  <th className="text-right">Amount paid</th>
                </tr>
              </thead>
              <tbody>
                {byIncident.map((i) => {
                  const pct = i.affected ? Math.round((i.paid / i.affected) * 100) : 0;
                  return (
                    <tr key={i.id}>
                      <td>
                        <Link className="font-medium hover:underline" href={`/incidents/${i.id}`}>
                          {i.title}
                        </Link>
                      </td>
                      <td>{words(i.status)}</td>
                      <td className="text-right tabular-nums">{i.affected}</td>
                      <td className="text-right tabular-nums">{i.paid}</td>
                      <td className="w-40">
                        <div className="h-2 overflow-hidden rounded-full bg-muted" title={`${pct}%`}>
                          <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{money(Number(i.paid_minor), currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Payment outcomes" hint="Every refund and payout Make Good has sent, by what PayPal said.">
            {ops === 0 ? (
              <p className="text-sm text-muted-foreground">No payments sent yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                  {byState.map(([state, n]) => (
                    <div
                      key={state}
                      className={STATE_TONE[state] ?? "bg-muted-foreground"}
                      style={{ width: `${(n / ops) * 100}%` }}
                      title={`${words(state)}: ${n}`}
                    />
                  ))}
                </div>
                <ul className="grid grid-cols-2 gap-2 text-sm">
                  {byState.map(([state, n]) => (
                    <li key={state} className="flex items-center gap-2">
                      <span className={`size-2.5 rounded-full ${STATE_TONE[state] ?? "bg-muted-foreground"}`} />
                      {words(state)} <span className="ml-auto tabular-nums text-muted-foreground">{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
          <Panel title="Why payments failed" hint="PayPal's own reason codes.">
            {failures.length === 0 ? (
              <p className="text-sm text-muted-foreground">No failed payments.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {failures.map((f) => (
                  <li key={f.failure_code} className="flex justify-between gap-3">
                    <span className="font-mono text-xs">{f.failure_code}</span>
                    <span className="tabular-nums">{f.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel title="Speed" hint="From building a payment list to its approval, and from starting payments to the last PayPal answer.">
          {timing.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payment lists yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Payment list</th>
                  <th className="text-right">To approval</th>
                  <th className="text-right">To finish</th>
                </tr>
              </thead>
              <tbody>
                {timing.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="text-right tabular-nums">{duration(t.seconds_to_approval)}</td>
                    <td className="text-right tabular-nums">{duration(t.seconds_to_finish)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
