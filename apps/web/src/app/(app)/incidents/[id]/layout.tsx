"use client";

import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, type ReactNode } from "react";
import { Alert, Badge } from "@/components/ui/primitives";
import { money } from "@/lib/format";
import { IncidentProvider, nextStep, useIncident } from "@/lib/incident-context";
import { cn } from "@/lib/utils";

const READY = ["ready", "in_a_batch", "in_progress", "outcome_unknown", "paid", "payment_failed"];

function Header() {
  const { map, batch, detail } = useIncident();
  const m = map.data!;
  const count = (d: string) => m.groups.find((g) => g.disposition === d)?.count ?? 0;
  const matched = Boolean(m.lastMatch);
  const ready = READY.reduce((a, d) => a + count(d), 0);
  const held = m.groups.filter((g) => g.group === "held").reduce((a, g) => a + g.count, 0);
  const paid = (batch.data?.operations ?? []).filter((o) => o.state === "succeeded");
  const paidSum = paid.reduce((a, o) => a + Number(o.amount_minor), 0);
  const env = m.dataLabels.paypal;

  const kpis: Array<[string, string, string]> = [
    [matched ? String(m.lastMatch!.stats.linesConsidered) : "–", "order lines checked", ""],
    [matched ? String(ready) : "–", "ready or approved", "text-ok"],
    [matched ? String(held) : "–", "waiting for a person", "text-hold"],
    [paid.length ? money(paidSum, paid[0]!.currency) : "–", `confirmed by PayPal${paid.length ? ` (${paid.length})` : ""}`, "text-info"],
  ];

  return (
    <div className="mb-6 flex flex-col gap-4">
      <Link href="/incidents" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Incidents
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">Recall case</p>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{detail.data?.incident.title ?? m.incident.title}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={env === "live" ? "stop" : "info"} title={m.dataLabels.paypalMeaning}>
            PayPal: {env === "simulator" ? "simulator, no real money" : env === "sandbox" ? "sandbox, test money" : env}
          </Badge>
          <Badge tone={m.dataLabels.merchantRecords === "synthetic" ? "hold" : "neutral"}>
            Records: {m.dataLabels.merchantRecords === "synthetic" ? "synthetic (invented)" : "your own"}
          </Badge>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map(([value, label, tone]) => (
          <div key={label} className="rounded-lg border bg-card px-4 py-3">
            <dd className={cn("text-xl font-semibold tabular-nums", tone)}>{value}</dd>
            <dt className="text-xs text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Tabs({ id }: { id: string }) {
  const { progress: p, batch } = useIncident();
  const pathname = usePathname();
  const next = nextStep(p, batch.data?.batch.status);
  const tabs: Array<{ slug: string; label: string; done: boolean; locked: boolean }> = [
    { slug: "notice", label: "Notice", done: p.rules, locked: false },
    { slug: "customers", label: "Customers", done: p.matched, locked: !p.rules },
    { slug: "evidence", label: "Evidence", done: p.matched, locked: !p.matched },
    { slug: "options", label: "Options", done: p.listed, locked: !p.matched },
    { slug: "approval", label: "Approval", done: p.approved, locked: !p.matched },
    { slug: "payments", label: "Payments", done: p.paid, locked: !p.approved },
    { slug: "claims", label: "Claims", done: false, locked: false },
    { slug: "activity", label: "Activity", done: false, locked: false },
  ];
  return (
    <div className="mb-6 flex flex-col gap-3">
      <nav aria-label="Steps" className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
        {tabs.map((t, i) => {
          const href = `/incidents/${id}/${t.slug}`;
          const active = pathname === href;
          const isNext = next?.tab === t.slug;
          return (
            <Link
              key={t.slug}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground",
                active && "border-primary text-foreground",
                t.locked && !t.done && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full border text-[10px]",
                  t.done && "border-ok bg-ok text-white",
                  isNext && !t.done && "border-primary text-primary",
                )}
                aria-hidden
              >
                {t.done ? <Check className="size-3" /> : t.slug === "activity" ? "·" : i + 1}
              </span>
              {t.label}
              {isNext ? <span className="sr-only">(next step)</span> : null}
            </Link>
          );
        })}
      </nav>
      {next && !pathname.endsWith(`/${next.tab}`) ? (
        <Link
          href={`/incidents/${id}/${next.tab}`}
          className="inline-flex w-fit items-center gap-2 rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground hover:bg-accent/80"
        >
          Next step: {next.text} <ArrowRight className="size-4" />
        </Link>
      ) : null}
    </div>
  );
}

function Body({ id, children }: { id: string; children: ReactNode }) {
  const { map, evidence } = useIncident();
  if (map.isPending || evidence.isPending) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (map.isError) return <Alert>{map.error.message}</Alert>;
  if (evidence.isError) return <Alert>{evidence.error.message}</Alert>;
  return (
    <>
      <Header />
      <Tabs id={id} />
      {children}
    </>
  );
}

export default function IncidentLayout({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  const { id } = use(params);
  return (
    <IncidentProvider incidentId={id}>
      <Body id={id}>{children}</Body>
    </IncidentProvider>
  );
}
