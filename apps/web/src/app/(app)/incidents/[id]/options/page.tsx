"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Locked, StepIntro } from "@/components/incident/bits";
import { CatalogPanel } from "@/components/incident/catalog-panel";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Alert, Card, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day, money, moneyMap } from "@/lib/format";
import { useIncident } from "@/lib/incident-context";
import { DEFAULT_POLICIES, RULES } from "@/lib/labels";
import { allowed } from "@/lib/org-action";
import { useOrg } from "@/lib/session";
import type { CatalogList, Compensation, PolicyComparison } from "@/lib/types";

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-t py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function OptionsStep() {
  const { map, incUrl, incidentId, candidates } = useIncident();
  const org = useOrg();
  const [priceWith, setPriceWith] = useState("current");
  const m = map.data!;
  const catalogKey = ["incident", org?.orgId, incidentId, "catalog"];
  const catalog = useQuery({ queryKey: catalogKey, queryFn: () => api.get<CatalogList>(`${incUrl}/catalog`), enabled: org !== null });
  // The latest confirmed catalogue product, if it had a price, prices one more option: its replacement value per unit.
  const ref = catalog.data?.references.find((r) => r.median_minor !== null && r.currency !== null) ?? null;
  const replacement: Compensation | null = ref ? { type: "fixed_per_unit", fixedMinor: ref.median_minor!, fixedCurrency: ref.currency! } : null;
  const ruleFor = (key: string): Compensation | null => (key === "catalog" ? replacement : (RULES[key]?.rule ?? null));
  const chosen = priceWith === "current" ? null : ruleFor(priceWith);
  const policies = useQuery({
    queryKey: ["incident", org?.orgId, incidentId, "policies", priceWith, ref?.id ?? null, candidates.dataUpdatedAt],
    queryFn: () =>
      api.post<PolicyComparison>(`${incUrl}/policies/compare`, chosen ? { policies: DEFAULT_POLICIES.map((p) => ({ ...p, compensation: chosen })) } : {}),
    enabled: Boolean(m.lastMatch),
    placeholderData: (prev) => prev,
  });

  const intro = (
    <StepIntro
      question="Step 4"
      title="What are the options, and what would each cost?"
      hint="A dry calculation on the records as they stand. Nothing is saved and nothing is paid by looking."
    />
  );
  if (!m.lastMatch)
    return (
      <>
        {intro}
        <Locked>Run the match first, in the Customers step.</Locked>
      </>
    );
  if (policies.isPending) return intro;
  if (policies.isError)
    return (
      <>
        {intro}
        <Alert>{policies.error.message}</Alert>
      </>
    );
  const p = policies.data;

  return (
    <>
      {intro}
      {catalog.data ? <CatalogPanel incUrl={incUrl} listKey={catalogKey} list={catalog.data} canWrite={allowed(org?.permissions, "incident.write")} /> : null}
      <div className="mb-5 flex max-w-xl flex-col gap-1.5">
        <Label htmlFor="price-with">Price each option with</Label>
        <div className="flex items-center gap-2">
          <Select id="price-with" value={priceWith} onChange={(e) => setPriceWith(e.target.value)}>
            <option value="current">The rule in force ({p.currentRule.inWords})</option>
            {Object.entries(RULES).map(([k, r]) => (
              <option key={k} value={k}>
                {r.label}
              </option>
            ))}
            {ref ? (
              <option value="catalog">
                Replacement value: {money(ref.median_minor!, ref.currency!)} for each affected unit (Channel3, {day(ref.retrieved_at)})
              </option>
            ) : null}
          </Select>
          {policies.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Recalculating" /> : null}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3" data-testid="policies">
        {p.policies.map((x) => (
          <Card key={x.key} className="flex flex-col p-5" data-policy={x.key}>
            <h3 className="font-semibold">{x.label}</h3>
            <p className="mt-3 text-3xl font-semibold tabular-nums">{moneyMap(x.payNow.amount)}</p>
            <p className="mb-3 text-sm text-muted-foreground">to {x.payNow.customers} customer(s) now, by refund to the original payment</p>
            <Line
              label="Of which: unit not proven"
              value={x.ofWhichUnproven.customers ? `${x.ofWhichUnproven.customers} · ${moneyMap(x.ofWhichUnproven.amount)}` : "none"}
            />
            {x.askedToConfirm !== null ? (
              <Line label="Asked to confirm their batch code" value={`${x.askedToConfirm} · up to ${moneyMap(x.additionalIfAllConfirm.amount)} more`} />
            ) : null}
            <Line label="Possibly affected, not paid" value={x.notPaid.customers} />
            <Line
              label="Waiting for the payment to be settled"
              value={
                x.blockedUntilPaymentReconciled.customers
                  ? `${x.blockedUntilPaymentReconciled.customers} · ${moneyMap(x.blockedUntilPaymentReconciled.amount)}`
                  : "none"
              }
            />
            <Line label="Owed outside PayPal or by hand" value={x.outsidePayPalOrManual.customers} />
            <p className="mt-3 text-sm">{x.tradeOff}</p>
            {x.againstKnownAnswers ? (
              <p className="mt-3 rounded-md bg-info/5 p-3 text-sm text-info">
                Against the known answers for this invented data: this option would pay for {x.againstKnownAnswers.unitsPaidThatWereNotAffected} unit(s) that
                were not affected, and leaves {x.againstKnownAnswers.affectedUnitsNotPaidNow} affected unit(s) unpaid for now.
              </p>
            ) : null}
            {x.key === "include_likely" && x.ofWhichUnproven.customers > 0 ? (
              <Button asChild size="sm" variant="outline" className="mt-3 w-fit">
                <Link href={`/incidents/${incidentId}/evidence?el=supported|uncertain`}>Review these records one by one</Link>
              </Button>
            ) : null}
          </Card>
        ))}
      </div>
      <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
        Choosing an option is not a button. To pay a record the records cannot prove, open it and confirm it in your name with a reason. To change what is owed,
        save a new version of the rules. Both withdraw any approval already given.
      </p>
    </>
  );
}
