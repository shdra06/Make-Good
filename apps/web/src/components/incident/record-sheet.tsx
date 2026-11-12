"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { EvidenceLine, Tag } from "@/components/incident/bits";
import { Button } from "@/components/ui/button";
import { Select, Table, Textarea } from "@/components/ui/form";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { day, money, time } from "@/lib/format";
import { useAction, useIncident } from "@/lib/incident-context";
import { BASIS, opLabel, PAYMENT, UNIT } from "@/lib/labels";
import type { CandidateDetail, Explanation } from "@/lib/types";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t py-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function ConfirmForm({ candidateId, onDone }: { candidateId: string; onDone: () => void }) {
  const { incUrl, orgUrl } = useIncident();
  const { run, pending } = useAction();
  const [basis, setBasis] = useState(BASIS[0]![0]);
  const [note, setNote] = useState("");
  const [link, setLink] = useState<{ url: string; emailedTo?: string } | null>(null);

  const decide = async (decision: "confirm" | "decline") => {
    const result = await run(
      async () => {
        const r = await api.post<{ changed: number; refused: Array<{ why: string }> }>(`${incUrl}/candidates/decide`, {
          candidateIds: [candidateId],
          decision,
          basis: decision === "confirm" ? basis : undefined,
          note: note.trim() || undefined,
        });
        if (r.changed === 0) throw new Error(r.refused[0]?.why ?? "Nothing changed.");
        return r;
      },
      decision === "confirm" ? "Confirmed in your name. Your reason is stored as evidence." : "Declined in your name.",
    );
    if (result) onDone();
  };
  const makeLink = async () => {
    const r = await run(() => api.post<{ url: string }>(`${orgUrl}/candidates/${candidateId}/confirm-link`));
    if (r) setLink({ url: r.url });
  };
  const emailLink = async () => {
    const r = await run(
      () => api.post<{ url: string; to: string }>(`${orgUrl}/candidates/${candidateId}/confirm-email`),
      "The email with the link is saved in the outbox.",
    );
    if (r) setLink({ url: r.url, emailedTo: r.to });
  };

  return (
    <Block title="Your decision">
      <p className="mb-3 text-sm text-muted-foreground">
        The records cannot settle this. If you confirm, your reason is stored as evidence in your name and shown on the payment list.
      </p>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="basis">What are you relying on?</Label>
          <Select id="basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
            {BASIS.map(([k, t]) => (
              <option key={k} value={k}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note">Note</Label>
          <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: customer sent a photo of the label, B-2217" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void decide("confirm")} disabled={pending}>
            Confirm this customer
          </Button>
          <Button variant="destructive" onClick={() => void decide("decline")} disabled={pending}>
            Decline
          </Button>
          <Button variant="outline" onClick={() => void makeLink()} disabled={pending}>
            Make a link to ask the customer
          </Button>
          <Button variant="outline" onClick={() => void emailLink()} disabled={pending}>
            Email the customer a link
          </Button>
        </div>
        {link ? (
          <div className="flex flex-col gap-1.5">
            {link.emailedTo ? <p className="text-sm">Emailed to {link.emailedTo}. Saved in the outbox as a file; not sent over the internet.</p> : null}
            <Label htmlFor="link">Send this link to the customer. It works once. Their answer appears here as evidence; you still decide.</Label>
            <Input id="link" readOnly value={link.url} onFocus={(e) => e.target.select()} />
          </div>
        ) : null}
      </div>
    </Block>
  );
}

function ReconcileForm({ d, onDone }: { d: CandidateDetail; onDone: () => void }) {
  const { orgUrl } = useIncident();
  const { run, pending } = useAction();
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const options = d.paymentOptions ?? [];

  const submit = async () => {
    const r = await run(async () => {
      if (!paymentId) throw new Error("Choose the payment that paid for this order.");
      if (!note.trim()) throw new Error("Say how you know: for example, the receipt the customer sent.");
      return api.post(`${orgUrl}/candidates/${d.candidate.id}/reconcile-payment`, { paymentTransactionId: paymentId, note: note.trim() });
    }, "The payment is settled in your name, and the match was run again.");
    if (r) onDone();
  };

  return (
    <Block title="Settle the payment">
      {options.length === 0 ? (
        <p className="text-sm">
          {d.order?.payment_reference
            ? `The store recorded PayPal payment ID ${d.order.payment_reference}, and PayPal does not know it. Correct the ID on the order and import it again.`
            : "No PayPal payment has been matched to this order. Nothing can be refunded until one is found."}
        </p>
      ) : (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm text-muted-foreground">
            More than one payment could be this order&apos;s. A refund goes to one payment, so a person must say which. Your choice is recorded in your name.
          </legend>
          {options.map((p) => (
            <label key={p.id} className="flex cursor-pointer gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent/50">
              <input type="radio" name="payment" className="mt-1" checked={paymentId === p.id} onChange={() => setPaymentId(p.id)} />
              <span className="text-sm">
                <span className="font-mono">{p.transaction_id}</span> · {money(p.gross_minor, p.currency)} · {day(p.occurred_at)} {time(p.occurred_at)}
                <span className="block text-xs text-muted-foreground">
                  {p.payer_name ?? "payer unknown"} · {p.detail}
                  {p.other_orders ? ` · also tied to ${p.other_orders} other order(s)` : ""}
                </span>
              </span>
            </label>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="how">How do you know?</Label>
            <Textarea
              id="how"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="For example: matches the PayPal receipt the customer forwarded"
            />
          </div>
          <Button className="w-fit" onClick={() => void submit()} disabled={pending}>
            This payment paid for the order
          </Button>
        </fieldset>
      )}
    </Block>
  );
}

export function RecordSheet({ candidateId, onClose }: { candidateId: string | null; onClose: () => void }) {
  const { orgUrl, map, evaluation, evidence } = useIncident();
  const { run, pending } = useAction();
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const detail = useQuery({
    queryKey: ["candidate", orgUrl, candidateId],
    queryFn: () => api.get<CandidateDetail>(`${orgUrl}/candidates/${candidateId}`),
    enabled: candidateId !== null,
  });
  const d = detail.data;
  const c = d?.candidate;
  const group = c ? (map.data!.groups.find((g) => g.disposition === c.disposition) ?? { label: c.disposition, why: "", group: "" }) : null;
  const held = c?.status === "proposed";
  const ev = (dim: string) => (d ? d.evidence.filter((e) => e.dimension === dim) : []);
  const truth = evaluation.data?.available && d?.order ? evaluation.data.cases.find((x) => x.orderNumber === d.order!.order_number) : undefined;

  const explain = async () => {
    const r = await run(() => api.post<Explanation>(`${orgUrl}/candidates/${candidateId}/explain`));
    if (r) setExplanation(r);
  };
  const close = () => {
    setExplanation(null);
    onClose();
  };

  return (
    <Sheet
      open={candidateId !== null}
      onOpenChange={(o) => (o ? null : close())}
      title={c ? (c.customer_name ?? c.customer_email ?? "Unknown customer") : "Customer record"}
      description={d ? (d.order ? `Order ${d.order.order_number} · ${day(d.order.placed_at)}` : "PayPal payment with no store order") : "Loading"}
    >
      {detail.isPending ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : detail.isError ? (
        <Alert>{detail.error.message}</Alert>
      ) : (
        d &&
        c && (
          <div data-testid="record">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Tag tone={group!.group === "held" ? "hold" : group!.group === "paid" ? "ok" : "neutral"}>{group!.label}</Tag>
              <span className="text-sm text-muted-foreground">{group!.why}</span>
            </div>

            <Block title="Question 1 · Does this PayPal payment belong to this order?">
              <p className="font-semibold">{PAYMENT[c.payment_identity].label}</p>
              <p className="mb-2 text-sm text-muted-foreground">{PAYMENT[c.payment_identity].meaning}</p>
              {d.payment ? (
                <p className="mb-2 text-sm">
                  PayPal payment <span className="font-mono">{d.payment.transaction_id}</span> · {money(d.payment.gross_minor, d.payment.currency)} · refunded
                  so far {money(d.payment.refunded_minor, d.payment.currency)} {d.payment.dispute_state === "open" ? <Tag tone="stop">dispute open</Tag> : null}
                </p>
              ) : null}
              {ev("payment").map((e, i) => (
                <EvidenceLine key={i} e={e} />
              ))}
            </Block>

            <Block title="Question 2 · Was this purchase affected?">
              <p className="font-semibold">{UNIT[c.eligibility].label}</p>
              <p className="mb-2 text-sm text-muted-foreground">{UNIT[c.eligibility].meaning}</p>
              {ev("eligibility").map((e, i) => (
                <EvidenceLine key={i} e={e} />
              ))}
            </Block>

            {ev("state").length > 0 ? (
              <Block title="The order and payment as they stand">
                {ev("state").map((e, i) => (
                  <EvidenceLine key={i} e={e} />
                ))}
              </Block>
            ) : null}

            {(c.missing ?? []).length > 0 ? (
              <Block title="What is missing">
                <ul className="list-disc pl-5 text-sm">
                  {c.missing!.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </Block>
            ) : null}

            {held && c.decision === "reconcile_payment" ? <ReconcileForm d={d} onDone={close} /> : null}
            {held && c.decision === "needs_eligibility_evidence" ? <ConfirmForm candidateId={c.id} onDone={close} /> : null}
            {held && c.decision === "investigate" ? (
              <Block title="Next step">
                <p className="text-sm">
                  {d.order
                    ? "Settle the payment first. Then the unit can be confirmed."
                    : "No order in the store's records carries this payment. Find the order, import it, and run the match again. PayPal's record alone cannot show which batch this customer received."}
                </p>
              </Block>
            ) : null}

            {c.decided_by_name ? (
              <p className="my-3 rounded-md bg-muted p-3 text-sm">
                {c.status === "declined" ? "Declined" : "Confirmed"} by {c.decided_by_name} on {day(c.decided_at)}
                {c.decision_basis ? `: ${(BASIS.find((b) => b[0] === c.decision_basis)?.[1] ?? c.decision_basis.replace(/_/g, " ")).toLowerCase()}` : ""}.
                {c.decision_note ? ` “${c.decision_note}”` : ""}
              </p>
            ) : null}

            {d.calculation ? (
              <Block title="What is owed, step by step">
                <Table>
                  <tbody>
                    {(d.calculation.steps.steps ?? []).map((s) => (
                      <tr key={s.label + s.detail}>
                        <td>
                          <span className="font-medium">{s.label}</span>
                          <p className="text-xs text-muted-foreground">{s.detail}</p>
                        </td>
                        <td className="text-right whitespace-nowrap tabular-nums">
                          {s.amountMinor === null ? "" : money(s.amountMinor, d.calculation!.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="mt-2 text-xs text-muted-foreground">{d.calculation.route_reason}</p>
              </Block>
            ) : null}

            {d.operations.length > 0 ? (
              <Block title="Payments for this record">
                {d.operations.map((o) => {
                  const l = opLabel(o);
                  return (
                    <div key={o.id} className="mb-3 text-sm">
                      <Tag tone={l.tone}>{l.label}</Tag> {money(o.amount_minor, o.currency)} {o.kind}
                      {o.provider_refund_id ? (
                        <>
                          {" "}
                          · PayPal refund <span className="font-mono">{o.provider_refund_id}</span>
                        </>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Request ID {o.idempotency_key} · {o.attempts} call(s) to PayPal · payment list version {o.manifest_version ?? "–"}
                      </p>
                      {o.failure_message ? (
                        <p className="text-xs text-destructive">
                          {o.failure_code}: {o.failure_message}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </Block>
            ) : null}

            {evidence.data!.ai.configured && held ? (
              <Block title="Explanation">
                {explanation ? (
                  <div data-testid="explanation">
                    <p className="mb-2 text-sm">{explanation.explanation.summary}</p>
                    <ul className="list-disc pl-5 text-sm">
                      {explanation.explanation.points.map((p) => (
                        <li key={p.text}>
                          {p.text} <span className="text-xs text-muted-foreground">[{p.cites.join(", ")}]</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Written by {explanation.model} from the evidence above only. It changes nothing about this record.
                    </p>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void explain()} disabled={pending}>
                    Ask the AI to explain why this is held
                  </Button>
                )}
              </Block>
            ) : null}

            {truth ? (
              <details className="mt-3 rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">The known answer for this invented record</summary>
                <p className="mt-2 text-sm">{truth.note}</p>
                <p className="text-xs text-muted-foreground">
                  In truth: {truth.truthAffectedUnits} affected unit(s); a correct PayPal refund would be {money(truth.owedMinor)}. The matching engine cannot
                  read this.
                </p>
              </details>
            ) : null}
          </div>
        )
      )}
    </Sheet>
  );
}
