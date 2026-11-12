"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { Locked, Panel, StepIntro, Stat, Tag } from "@/components/incident/bits";
import { Table } from "@/components/ui/form";
import { Alert } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day } from "@/lib/format";
import { useIncident } from "@/lib/incident-context";
import { UNIT } from "@/lib/labels";
import { useOrg } from "@/lib/session";
import type { RecallTimeline } from "@/lib/types";

// Bryntum needs the browser, so the chart loads on the client only.
const Chart = dynamic(() => import("@/components/incident/recall-timeline"), {
  ssr: false,
  loading: () => <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading the timeline" />,
});

const STILL_OWED = (disposition: string) => !["paid", "not_affected", "excluded", "declined"].includes(disposition);

export default function TimelineStep() {
  const { incUrl, incidentId } = useIncident();
  const org = useOrg();
  const q = useQuery({
    queryKey: ["incident", org?.orgId, incidentId, "timeline"],
    queryFn: () => api.get<RecallTimeline>(`${incUrl}/timeline`),
    enabled: org !== null,
  });
  // "Today" is when the data was loaded, so the chart and the table agree.
  const now = useMemo(() => new Date(q.dataUpdatedAt), [q.dataUpdatedAt]);

  const intro = (
    <StepIntro
      question="Recall timeline"
      title="When each batch shipped, and how long PayPal still allows a refund"
      hint="Drawn from your stock records, ship dates and PayPal payments. This view is read only: nothing on it changes a record or moves money. Hover a bar for its source."
    />
  );
  if (q.isPending)
    return (
      <>
        {intro}
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </>
    );
  if (q.isError)
    return (
      <>
        {intro}
        <Alert>{q.error.message}</Alert>
      </>
    );
  const t = q.data;
  if (!t.scope || !t.summary)
    return (
      <>
        {intro}
        <Locked>Save the rules on the Notice step first. The timeline needs to know which products and batches are recalled.</Locked>
      </>
    );
  if (t.records.length === 0 && t.batches.length === 0)
    return (
      <>
        {intro}
        <Locked>Find the customers on the Customers step first.</Locked>
      </>
    );

  const s = t.summary;
  const attention = t.records
    .filter((r) => (r.deadline === "closed" || r.deadline === "closing_soon") && STILL_OWED(r.disposition))
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));

  return (
    <>
      {intro}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat value={s.records} label="customer records on the line" />
        <Stat value={t.mixedStock.length} label="periods of mixed stock" tone={t.mixedStock.length ? "text-hold" : undefined} />
        <Stat
          value={s.owedClosingSoon}
          label={`still owed, refund window closes within ${t.closingSoonDays} days`}
          tone={s.owedClosingSoon ? "text-hold" : undefined}
        />
        <Stat value={s.owedAfterWindowClosed} label="still owed, refund window closed" tone={s.owedAfterWindowClosed ? "text-destructive" : undefined} />
      </div>

      {s.owedAfterWindowClosed > 0 ? (
        <Alert className="mb-5">
          {s.owedAfterWindowClosed} {s.owedAfterWindowClosed === 1 ? "record is" : "records are"} still owed after PayPal&apos;s {t.refundWindowDays}-day refund
          window closed. PayPal will refuse a refund; these need a payout, approved on its own list, or another route.
        </Alert>
      ) : null}

      <Panel
        title="Timeline"
        hint={`Batches: red is recalled, blue is not, grey is in stock before shipping. Orange: two batches leaving at once. Customer rows: the dot is the ship date, the bar is PayPal's ${t.refundWindowDays}-day refund window (teal open, orange closing, red closed).`}
        actions={
          <>
            <Tag tone={t.labels.merchantRecords === "synthetic" ? "hold" : "neutral"}>
              Records: {t.labels.merchantRecords === "synthetic" ? "synthetic (invented)" : "your own"}
            </Tag>
            <Tag tone="info">Read only</Tag>
          </>
        }
      >
        {t.batches.length === 0 ? (
          <p className="mb-3 text-sm text-muted-foreground">
            No stock records for {t.scope.skus.join(", ")}, so batch windows cannot be drawn. Ship dates and refund windows still are.
          </p>
        ) : null}
        <Chart data={t} now={now} />
      </Panel>

      <Panel
        className="mt-5"
        title="Refund deadlines that need attention"
        hint={`Records still owed whose PayPal refund window closes within ${t.closingSoonDays} days, or has closed. Soonest first.`}
        testId="deadlines"
      >
        {attention.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None today. Every record still owed has more than {t.closingSoonDays} days left, or no PayPal payment.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Affected?</th>
                <th>Paid</th>
                <th>Refund possible until</th>
                <th>Days left</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((r) => (
                <tr key={r.candidateId}>
                  <td className="tabular-nums">{r.orderNumber ?? "–"}</td>
                  <td>{r.customerName ?? "–"}</td>
                  <td>{UNIT[r.eligibility]?.label ?? r.eligibility}</td>
                  <td className="tabular-nums">{day(r.paidAt)}</td>
                  <td className="tabular-nums">{day(r.refundDeadline)}</td>
                  <td className="tabular-nums">{r.deadline === "closed" ? <Tag tone="stop">closed</Tag> : <Tag tone="hold">{r.daysLeft}</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
