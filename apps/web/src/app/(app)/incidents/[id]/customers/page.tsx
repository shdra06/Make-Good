"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Locked, Panel, Stat, StepIntro, Tag } from "@/components/incident/bits";
import { CsvUpload } from "@/components/incident/csv-upload";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/form";
import { api } from "@/lib/api";
import { moneyMap, time, words } from "@/lib/format";
import { useAction, useIncident } from "@/lib/incident-context";
import { cellAction, PAYMENT, UNIT } from "@/lib/labels";
import { useOrg } from "@/lib/session";
import type { AliasResponse, AliasSuggestion, Eligibility, MatchResult, PaymentIdentity } from "@/lib/types";
import { cn } from "@/lib/utils";

const READY = ["ready", "in_a_batch", "in_progress", "outcome_unknown", "paid", "payment_failed"];
const IDENTITIES: PaymentIdentity[] = ["verified", "ambiguous", "missing", "not_paypal"];
const UNITS: Eligibility[] = ["proven", "supported", "uncertain", "unknown"];
const TONE_CELL = { ok: "border-ok/40 bg-ok/10 hover:bg-ok/15", hold: "border-hold/40 bg-hold/10 hover:bg-hold/15" } as const;

function Aliases({ aliases, aiConfigured }: { aliases: AliasResponse; aiConfigured: boolean }) {
  const { incUrl, orgUrl, incidentId } = useIncident();
  const org = useOrg();
  const client = useQueryClient();
  const { run, pending } = useAction();
  const open = aliases.aliases.filter((a) => a.status === "suggested");

  const decide = (a: AliasSuggestion, decision: "confirm" | "reject") =>
    run(
      async () => {
        await api.post(`${orgUrl}/aliases/${a.id}/decision`, { decision });
        await api.post(`${incUrl}/match`);
      },
      decision === "confirm" ? `"${a.alias}" is now treated as ${a.canonicalSku}, in your name. The match was run again.` : `"${a.alias}" will stay unmatched.`,
    );

  const askAi = () =>
    run(
      async () => {
        const r = await api.post<AliasResponse>(`${incUrl}/aliases/suggest`, { withAi: true });
        client.setQueryData(["incident", org?.orgId, incidentId, "aliases"], r);
        return r;
      },
      (r) => r.aiNote ?? null,
    );

  if (aliases.aliases.length === 0) return null;
  return (
    <Panel
      testId="aliases"
      title="Product codes written differently"
      hint={
        open.length > 0
          ? `${open.length} kind(s) of order line look like a recalled product but do not carry its code. They are not matched. Only you can say whether they are the same product.`
          : "Every look-alike product code has been decided."
      }
      actions={
        aiConfigured && open.length > 0 ? (
          <Button size="sm" variant="outline" onClick={() => void askAi()} disabled={pending}>
            Ask the AI for an opinion on these
          </Button>
        ) : null
      }
    >
      <Table>
        <thead>
          <tr>
            <th>On the order</th>
            <th>Looks like</th>
            <th>Why it was noticed</th>
            <th className="text-right">Lines</th>
            <th>Batch codes recorded</th>
            <th>
              <span className="sr-only">Decision</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {aliases.aliases.map((a) => (
            <tr key={a.id} data-alias={a.alias}>
              <td>
                <span className="font-semibold">{a.alias}</span>
                <p className="text-xs text-muted-foreground">{a.sampleTitles.join(" · ")}</p>
              </td>
              <td>{a.canonicalSku}</td>
              <td className="max-w-sm">
                {a.reason}
                {a.ai ? (
                  <p className="mt-1 rounded-md bg-info/5 p-2 text-xs text-info">
                    The model&apos;s opinion ({a.ai.model}): {words(a.ai.verdict)}. {a.ai.reason} It quoted “{a.ai.quotedTitle}”. This is an opinion, not a
                    decision.
                  </p>
                ) : null}
              </td>
              <td className="text-right tabular-nums">{a.lines}</td>
              <td>{a.batchCodes.join(", ") || "–"}</td>
              <td className="whitespace-nowrap">
                {a.status === "suggested" ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => void decide(a, "confirm")} disabled={pending}>
                      Same product
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void decide(a, "reject")} disabled={pending}>
                      Different
                    </Button>
                  </div>
                ) : (
                  <Tag tone={a.status === "confirmed" ? "ok" : "neutral"}>
                    {a.status === "confirmed" ? `same product: ${a.decidedBy ?? "confirmed"}` : `different: ${a.decidedBy ?? "rejected"}`}
                  </Tag>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

export default function CustomersStep() {
  const { map, evidence, incUrl, incidentId } = useIncident();
  const org = useOrg();
  const router = useRouter();
  const { run, pending } = useAction();
  const [lastMatch, setLastMatch] = useState<MatchResult | null>(null);
  const m = map.data!;
  const matched = Boolean(m.lastMatch);

  const aliases = useQuery({
    queryKey: ["incident", org?.orgId, incidentId, "aliases"],
    queryFn: () => api.post<AliasResponse>(`${incUrl}/aliases/suggest`, { withAi: false }),
    enabled: matched,
  });

  const findCustomers = async () => {
    const r = await run(() => api.post<MatchResult>(`${incUrl}/match`));
    if (r) setLastMatch(r);
  };

  if (!m.rule) {
    return (
      <>
        <StepIntro question="Step 2" title="Who might be affected?" />
        <Locked>Save the rules first, in the Notice step.</Locked>
      </>
    );
  }

  const count = (d: string) => m.groups.find((g) => g.disposition === d)?.count ?? 0;
  const live = m.matrix.reduce((a, c) => a + c.count, 0);
  const ready = READY.reduce((a, d) => a + count(d), 0);
  const held = m.groups.filter((g) => g.group === "held").reduce((a, g) => a + g.count, 0);
  const rows = IDENTITIES.filter((i) => m.matrix.some((c) => c.paymentIdentity === i));
  const disputes = lastMatch?.disputes;

  return (
    <>
      <StepIntro
        question="Step 2"
        title="Who might be affected?"
        hint="PayPal knows who paid. It does not know which batch anyone received. Only the merchant's packing records, or the customer, can say."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant={matched ? "outline" : "default"} onClick={() => void findCustomers()} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {matched ? "Run the match again" : "Find affected customers"}
        </Button>
        {m.lastMatch ? <span className="text-sm text-muted-foreground">Last run {time(m.lastMatch.finished_at)}.</span> : null}
        {disputes ? (
          <span className="text-sm text-muted-foreground">
            {disputes.failed ? disputes.failed : `PayPal was asked about disputes on ${disputes.checked} payments: ${disputes.open} open.`}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-6">
        <CsvUpload />

        {matched ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat value={m.lastMatch!.stats.linesConsidered} label="order lines for the product" />
              <Stat value={count("not_affected")} label="shown not to be affected" />
              <Stat value={live} label="records that may be owed" />
              <Stat value={ready} label="settled by the records or by a person" tone="text-ok" />
              <Stat value={held} label="waiting for a person" tone="text-hold" />
            </div>

            <Panel
              title="The two answers, crossed"
              hint="Down: does this PayPal payment belong to this order? Across: was this purchase affected? These are categories with stated grounds. There are no scores. Open a cell to see its records."
            >
              <div className="overflow-x-auto">
                <div
                  className="grid min-w-[44rem] grid-cols-[10rem_repeat(4,1fr)] gap-2"
                  role="table"
                  aria-label="Payment identity by unit eligibility"
                  data-testid="matrix"
                >
                  <div role="columnheader" />
                  {UNITS.map((u) => (
                    <div key={u} role="columnheader" title={UNIT[u].meaning} className="px-2 text-xs font-medium text-muted-foreground">
                      {UNIT[u].label}
                    </div>
                  ))}
                  {rows.map((i) => (
                    <div key={i} role="row" className="contents">
                      <div role="rowheader" title={PAYMENT[i].meaning} className="flex items-center text-sm font-medium">
                        {PAYMENT[i].label}
                      </div>
                      {UNITS.map((u) => {
                        const c = m.matrix.find((x) => x.paymentIdentity === i && x.eligibility === u);
                        const action = cellAction(i, u);
                        return (
                          <button
                            key={u}
                            role="cell"
                            disabled={!c}
                            onClick={() => router.push(`/incidents/${incidentId}/evidence?pi=${i}&el=${u}`)}
                            className={cn(
                              "flex min-h-20 flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors disabled:border-dashed disabled:bg-transparent disabled:opacity-50",
                              c && TONE_CELL[action.tone === "ok" ? "ok" : "hold"],
                            )}
                          >
                            <span className="text-xl font-semibold tabular-nums">{c?.count ?? 0}</span>
                            {c ? <span className="text-xs font-medium">{action.label}</span> : null}
                            {c ? <span className="text-xs text-muted-foreground tabular-nums">{moneyMap(c.amount)}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </Panel>

            {aliases.data ? <Aliases aliases={aliases.data} aiConfigured={evidence.data!.ai.configured} /> : null}
          </>
        ) : null}
      </div>
    </>
  );
}
