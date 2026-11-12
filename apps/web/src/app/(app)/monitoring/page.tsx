"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Panel } from "@/components/incident/bits";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/form";
import { Alert, Badge } from "@/components/ui/primitives";
import { TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { money, time, words } from "@/lib/format";
import { allowed, useOrgAction } from "@/lib/org-action";
import { orgPath, useOrg } from "@/lib/session";

type Detection = {
  id: string;
  detector: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  status: string;
  incident_id: string | null;
  updated_at: string;
};
type Difference = {
  id: string;
  kind: string;
  severity: string;
  status: string;
  expected: unknown;
  actual: unknown;
  created_at: string;
  amount_minor: number | null;
  currency: string | null;
  operation_state: string | null;
};
type ErrorRow = { id: number; source: "request" | "job"; where: string; message: string; detail: string | null; created_at: string };
type AuditRow = { id: number; actor_kind: string; actor_name: string | null; action: string; entity_type: string; created_at: string };

const SEVERITY = { critical: "stop", warning: "hold", info: "info" } as const;

function Empty({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <CheckCircle2 className="size-4 text-ok" /> {children}
    </p>
  );
}

export default function MonitoringPage() {
  const org = useOrg();
  const enabled = org !== null;
  const path = (p: string) => orgPath(org!, p);
  const detections = useQuery({
    queryKey: ["detections", org?.orgId],
    queryFn: () => api.get<{ findings: Detection[] }>(path("/detections")).then((r) => r.findings),
    enabled,
  });
  const differences = useQuery({ queryKey: ["reconciliation", org?.orgId], queryFn: () => api.get<Difference[]>(path("/reconciliation")), enabled });
  const canManage = allowed(org?.permissions, "org.manage");
  const canAudit = allowed(org?.permissions, "audit.read");
  const errors = useQuery({
    queryKey: ["errors", org?.orgId],
    queryFn: () => api.get<{ total: number; rows: ErrorRow[] }>(path("/errors?size=20")),
    enabled: enabled && canManage,
  });
  const audit = useQuery({
    queryKey: ["audit", org?.orgId],
    queryFn: () => api.get<{ rows: AuditRow[]; chain: { ok: boolean; rows: number } }>(path("/audit?size=30")),
    enabled: enabled && canAudit,
  });
  const { run, pending } = useOrgAction([["detections", org?.orgId]]);
  if (!org) return null;
  const canDetect = allowed(org.permissions, "detection.manage");
  const open = (detections.data ?? []).filter((d) => d.status === "open");

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="What needs attention: findings in your PayPal data, differences from PayPal's records, errors, and the audit trail."
      />
      <div className="flex flex-col gap-6">
        <Panel
          title={`Findings${open.length ? ` (${open.length} open)` : ""}`}
          hint="Checks run every few minutes: duplicate charges, refund spikes, failed refunds, payments with an unknown outcome."
          actions={
            canDetect ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => api.post(path("/detections/run")), "Checks ran.")}>
                <Play /> Run checks now
              </Button>
            ) : null
          }
          testId="findings"
        >
          {detections.isPending ? (
            <TableSkeleton rows={2} />
          ) : detections.isError ? (
            <Alert>{detections.error.message}</Alert>
          ) : detections.data.length === 0 ? (
            <Empty>No findings. Nothing unusual in your PayPal data.</Empty>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {detections.data.map((d) => (
                <li key={d.id} className="flex flex-wrap items-start gap-3 p-3">
                  <Badge tone={SEVERITY[d.severity]}>{d.severity}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{d.title}</p>
                    <p className="text-sm text-muted-foreground">{d.summary}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {words(d.detector)} · {time(d.updated_at)} · {d.status}
                      {d.incident_id ? (
                        <>
                          {" · "}
                          <Link className="underline" href={`/incidents/${d.incident_id}`}>
                            incident
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  {canDetect && d.status === "open" ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => void run(() => api.post(path(`/detections/${d.id}/status`), { status: "acknowledged" }), "Marked as seen.")}
                      >
                        Seen
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => void run(() => api.post(path(`/detections/${d.id}/status`), { status: "dismissed" }), "Dismissed.")}
                      >
                        Dismiss
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Differences from PayPal"
          hint="After each payment run, Make Good asks PayPal what actually happened and lists anything that does not agree."
        >
          {differences.isPending ? (
            <TableSkeleton rows={2} />
          ) : differences.isError ? (
            <Alert>{differences.error.message}</Alert>
          ) : differences.data.length === 0 ? (
            <Empty>No differences. Every payment agrees with PayPal.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Amount</th>
                  <th>Payment state</th>
                  <th>Status</th>
                  <th>Found</th>
                </tr>
              </thead>
              <tbody>
                {differences.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Badge tone={r.severity === "critical" ? "stop" : r.severity === "warning" ? "hold" : "info"}>{words(r.kind)}</Badge>
                    </td>
                    <td className="tabular-nums">{r.amount_minor === null ? "–" : money(r.amount_minor, r.currency ?? "USD")}</td>
                    <td>{r.operation_state ? words(r.operation_state) : "–"}</td>
                    <td>{r.status}</td>
                    <td className="text-muted-foreground">{time(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        {canManage ? (
          <Panel title="Errors" hint="Server errors and failed background jobs in this workspace. Customers only ever see a short message." testId="errors">
            {errors.isPending ? (
              <TableSkeleton rows={2} />
            ) : errors.isError ? (
              <Alert>{errors.error.message}</Alert>
            ) : errors.data.total === 0 ? (
              <Empty>No errors recorded.</Empty>
            ) : (
              <ul className="flex flex-col divide-y rounded-lg border">
                {errors.data.rows.map((e) => (
                  <li key={e.id} className="p-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone="stop">{e.source}</Badge>
                      <span className="font-mono text-xs">{e.where}</span>
                      <span className="text-xs text-muted-foreground">{time(e.created_at)}</span>
                    </p>
                    <p className="mt-1 text-sm">{e.message}</p>
                    {e.detail ? (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Details</summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{e.detail}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}

        {canAudit ? (
          <Panel
            title="Audit trail"
            hint="Every decision, approval and payment, chained so that an edit to any past entry shows."
            actions={
              audit.data ? (
                audit.data.chain.ok ? (
                  <Badge tone="ok">
                    <ShieldCheck className="size-3" /> Unaltered ({audit.data.chain.rows} entries)
                  </Badge>
                ) : (
                  <Badge tone="stop">
                    <ShieldAlert className="size-3" /> Altered
                  </Badge>
                )
              ) : null
            }
            testId="audit"
          >
            {audit.isPending ? (
              <TableSkeleton />
            ) : audit.isError ? (
              <Alert>{audit.error.message}</Alert>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.rows.map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap text-muted-foreground">{time(a.created_at)}</td>
                      <td>{a.actor_name ?? a.actor_kind}</td>
                      <td>{words(a.action)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
