"use client";

// The recall drawn on Bryntum Scheduler (Community tier, MIT).
// Rows: each stock batch, the days stock was mixed, key dates, then every
// customer record. Read only: nothing can be dragged, edited or created here,
// so this view can never change a record or move money.

// Icons from the package itself. Without them Bryntum fetches Font Awesome
// from a CDN, which our Content-Security-Policy rightly blocks.
import "@bryntum/core-community/fontawesome/css/fontawesome.css";
import "@bryntum/core-community/fontawesome/css/solid.css";
import "@bryntum/scheduler-community/scheduler.css";
import "@bryntum/scheduler-community/svalbard.css";
import { BryntumScheduler } from "@bryntum/scheduler-react-community";
import { useMemo } from "react";
import { UNIT } from "@/lib/labels";
import type { RecallTimeline as Data, TimelineDeadline } from "@/lib/types";

const DAY = 24 * 60 * 60 * 1000;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const d = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const ELIGIBILITY_COLOR: Record<string, string> = { proven: "red", supported: "orange", uncertain: "yellow", unknown: "gray", not_affected: "green" };
const DEADLINE_COLOR: Record<TimelineDeadline, string> = { open: "teal", closing_soon: "orange", closed: "red", no_paypal_payment: "gray" };
const DEADLINE_TEXT: Record<TimelineDeadline, string> = {
  open: "PayPal refund window open",
  closing_soon: "PayPal refund window closing soon",
  closed: "PayPal refund window closed: a payout or another route is needed",
  no_paypal_payment: "No PayPal payment linked",
};

type Resource = { id: string; name: string; kind: string; cls?: string };
type Event = { id: string; resourceId: string; name: string; startDate: Date; endDate: Date; eventColor: string; tip: string; cls?: string };

export function buildTimeline(t: Data, now: Date) {
  const resources: Resource[] = [];
  const events: Event[] = [];
  const add = (e: Omit<Event, "endDate"> & { endDate?: Date }) => events.push({ ...e, endDate: e.endDate ?? e.startDate });

  for (const b of t.batches) {
    const id = `batch:${b.id}`;
    resources.push({ id, name: `Batch ${b.batchCode}`, kind: b.affected ? "Recalled batch" : "Not recalled" });
    const where = `${esc(b.sku)}, warehouse "${esc(b.warehouse)}"`;
    if (b.receivedAt && b.firstShippedAt && b.receivedAt < b.firstShippedAt) {
      add({
        id: `${id}:stock`,
        resourceId: id,
        name: "In stock",
        startDate: new Date(b.receivedAt),
        endDate: new Date(b.firstShippedAt),
        eventColor: "gray",
        tip: `<b>Batch ${esc(b.batchCode)} in stock</b><br>${where}<br>Received ${d(b.receivedAt)}, first shipped ${d(b.firstShippedAt)}`,
      });
    }
    if (b.firstShippedAt && b.lastShippedAt) {
      add({
        id: `${id}:ship`,
        resourceId: id,
        name: `Shipping ${b.batchCode}`,
        startDate: new Date(b.firstShippedAt),
        endDate: new Date(b.lastShippedAt),
        eventColor: b.affected ? "red" : "blue",
        tip: `<b>Batch ${esc(b.batchCode)} shipping</b> (${b.affected ? "recalled" : "not recalled"})<br>${where}<br>${d(b.firstShippedAt)} to ${d(b.lastShippedAt)}<br><i>From your inventory records.</i>`,
      });
    }
  }

  if (t.mixedStock.length) {
    resources.push({ id: "mixed", name: "Mixed stock", kind: "Two batches at once" });
    t.mixedStock.forEach((m, i) =>
      add({
        id: `mixed:${i}`,
        resourceId: "mixed",
        name: `${m.affectedBatch} + ${m.otherBatch}`,
        startDate: new Date(m.from),
        endDate: new Date(m.to),
        eventColor: "orange",
        tip: `<b>Mixed stock</b><br>${esc(m.affectedBatch)} (recalled) and ${esc(m.otherBatch)} were both leaving warehouse "${esc(m.warehouse)}"<br>${d(m.from)} to ${d(m.to)}<br>An order shipped in these days without a batch code cannot be proven either way.`,
      }),
    );
  }

  resources.push({ id: "key", name: "Key dates", kind: "Reference" });
  add({ id: "key:today", resourceId: "key", name: "Today", startDate: now, eventColor: "violet", tip: `<b>Today</b><br>${d(now.toISOString())}` });
  if (t.scope?.shippedFrom && t.scope.shippedTo) {
    add({
      id: "key:stated",
      resourceId: "key",
      name: "Stated ship window",
      startDate: new Date(t.scope.shippedFrom),
      endDate: new Date(t.scope.shippedTo),
      eventColor: "gray",
      tip: `<b>Ship window stated in the rules</b><br>${d(t.scope.shippedFrom)} to ${d(t.scope.shippedTo)}<br><i>A single-source statement, not a record.</i>`,
    });
  }

  for (const r of t.records) {
    const id = `rec:${r.candidateId}`;
    const who =
      [r.orderNumber ? (r.orderNumber.startsWith("#") ? r.orderNumber : `#${r.orderNumber}`) : null, r.customerName].filter(Boolean).join(" · ") || "Record";
    resources.push({ id, name: who, kind: UNIT[r.eligibility]?.label ?? r.eligibility });
    const base = `<b>${esc(who)}</b><br>${esc(r.sku ?? "")} × ${r.quantity}<br>Affected? ${esc(UNIT[r.eligibility]?.label ?? r.eligibility)}<br>Where it stands: ${esc(r.dispositionLabel)}`;
    if (r.paidAt && r.refundDeadline) {
      add({
        id: `${id}:window`,
        resourceId: id,
        name: r.deadline === "closed" ? "Refund window closed" : `Refund window · ${r.daysLeft} days left`,
        startDate: new Date(r.paidAt),
        endDate: new Date(r.refundDeadline),
        eventColor: DEADLINE_COLOR[r.deadline],
        tip: `${base}<br><br><b>${DEADLINE_TEXT[r.deadline]}</b><br>Paid ${d(r.paidAt)}; PayPal allows a refund until ${d(r.refundDeadline)}${r.daysLeft !== null && r.daysLeft >= 0 ? ` (${r.daysLeft} days left)` : ""}`,
      });
    }
    if (r.shippedAt) {
      const batches = r.recordedBatches.length ? `batch ${r.recordedBatches.map(esc).join(", ")} written at packing` : "no batch code written at packing";
      add({
        id: `${id}:ship`,
        resourceId: id,
        name: "Shipped",
        startDate: new Date(r.shippedAt),
        eventColor: ELIGIBILITY_COLOR[r.eligibility] ?? "gray",
        tip: `${base}<br><br><b>Shipped ${d(r.shippedAt)}</b>${r.warehouse ? ` from "${esc(r.warehouse)}"` : ""}<br>${batches}`,
      });
    }
  }

  const times = events.flatMap((e) => [e.startDate.getTime(), e.endDate.getTime()]);
  const start = new Date(Math.min(...times) - 7 * DAY);
  const end = new Date(Math.max(...times) + 7 * DAY);
  return { resources, events, start, end };
}

export default function RecallTimelineChart({ data, now }: { data: Data; now: Date }) {
  const { resources, events, start, end } = useMemo(() => buildTimeline(data, now), [data, now]);
  return (
    <div className="h-[620px] overflow-hidden rounded-lg border" data-testid="recall-timeline">
      <BryntumScheduler
        readOnly
        startDate={start}
        endDate={end}
        viewPreset="weekAndMonth"
        rowHeight={34}
        barMargin={4}
        resourceStore={{ fields: ["kind"] }}
        eventStore={{ fields: ["tip"] }}
        resources={resources}
        events={events}
        columns={[
          { text: "Row", field: "name", width: 210 },
          { text: "What it is", field: "kind", width: 140 },
        ]}
        eventTooltipFeature={{ template: ({ eventRecord }: { eventRecord: { get: (f: string) => unknown } }) => String(eventRecord.get("tip") ?? "") }}
        eventMenuFeature={false}
        scheduleMenuFeature={false}
        eventDragCreateFeature={false}
        eventEditFeature={false}
        cellEditFeature={false}
      />
    </div>
  );
}
