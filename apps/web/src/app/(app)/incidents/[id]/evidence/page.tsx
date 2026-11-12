"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Locked, StepIntro, Tag } from "@/components/incident/bits";
import { RecordSheet } from "@/components/incident/record-sheet";
import { Button } from "@/components/ui/button";
import { money, moneyMap } from "@/lib/format";
import { useIncident } from "@/lib/incident-context";
import { PAYMENT, UNIT } from "@/lib/labels";
import type { CandidateRow, Eligibility, PaymentIdentity } from "@/lib/types";

function RecordRow({ r, onOpen }: { r: CandidateRow; onOpen: () => void }) {
  const cleared = r.status === "cleared";
  return (
    <button
      onClick={onOpen}
      className="grid w-full gap-2 border-t px-4 py-3 text-left text-sm first:border-t-0 hover:bg-muted/50 md:grid-cols-[7rem_10rem_1fr_auto_6rem] md:items-center"
      data-order={r.order_number ?? ""}
    >
      <span className="font-mono">{r.order_number ?? "no order"}</span>
      <span className="truncate font-medium">{r.customer_name ?? r.customer_email ?? "unknown customer"}</span>
      <span className="truncate text-muted-foreground">
        {r.line_title ? `${r.affected_quantity} × ${r.sku ? r.sku.trim() : "(no product code)"} · ${r.line_title}` : "PayPal payment with no store order"}
      </span>
      <span className="flex flex-wrap gap-1">
        {!cleared ? (
          <Tag tone={PAYMENT[r.payment_identity].tone} title={PAYMENT[r.payment_identity].meaning}>
            {PAYMENT[r.payment_identity].label}
          </Tag>
        ) : null}
        <Tag tone={UNIT[r.eligibility].tone} title={UNIT[r.eligibility].meaning}>
          {UNIT[r.eligibility].label}
        </Tag>
        {r.decided_by ? <Tag>by {r.decided_by}</Tag> : null}
      </span>
      <span className="text-right tabular-nums">
        {r.payment_state === "succeeded" ? money(r.payment_amount_minor, r.currency) : r.payable_minor ? money(r.payable_minor, r.currency) : "–"}
      </span>
    </button>
  );
}

function EvidenceStep() {
  const { map, candidates } = useIncident();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const m = map.data!;

  const pi = params.get("pi") as PaymentIdentity | null;
  const el = params.get("el");
  const open = params.get("record");
  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(name);
    else next.set(name, value);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  if (!m.lastMatch) {
    return (
      <>
        <StepIntro question="Step 3" title="What does the evidence say?" />
        <Locked>Run the match first, in the Customers step.</Locked>
      </>
    );
  }

  const rows = candidates.data?.rows ?? [];
  const filtered = pi || el;
  const shown = rows.filter(
    (r) => !filtered || ((!pi || r.payment_identity === pi) && (!el || el.split("|").includes(r.eligibility)) && r.status !== "cleared"),
  );
  const groups = m.groups.map((g) => ({ ...g, rows: shown.filter((r) => r.disposition === g.disposition) })).filter((g) => g.rows.length > 0);
  const filterLabel = [
    pi ? PAYMENT[pi].label : null,
    el
      ? el
          .split("|")
          .map((x) => UNIT[x as Eligibility]?.label ?? x)
          .join(" or ")
      : null,
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <>
      <StepIntro
        question="Step 3"
        title="What does the evidence say?"
        hint="The Recovery Map. Every buyer of the product, where the record stands, and why. Open a row for the records behind it."
      />
      {filtered ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          Showing: <Tag tone="info">{filterLabel}</Tag>
          <Button size="sm" variant="ghost" onClick={() => router.replace(pathname, { scroll: false })}>
            <X /> Show everyone
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <section key={g.disposition} className="overflow-hidden rounded-xl border bg-card" data-group={g.disposition}>
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b bg-muted/40 px-4 py-3">
              <h3 className="font-semibold">
                {g.label} · {g.rows.length}
              </h3>
              <span className="text-sm text-muted-foreground">{g.why}</span>
              <span className="ml-auto text-sm font-medium tabular-nums">
                {g.disposition === "paid" ? moneyMap(g.paid) : g.group === "left_out" ? "" : moneyMap(g.amount)}
              </span>
            </header>
            {g.rows.map((r) => (
              <RecordRow key={r.id} r={r} onOpen={() => setParam("record", r.id)} />
            ))}
          </section>
        ))}
        {groups.length === 0 ? <p className="text-sm text-muted-foreground">No records match this view.</p> : null}
      </div>
      <RecordSheet candidateId={open} onClose={() => setParam("record", null)} />
    </>
  );
}

export default function EvidencePage() {
  return (
    <Suspense>
      <EvidenceStep />
    </Suspense>
  );
}
