"use client";

import { Loader2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Panel, Row, StepIntro, Tag } from "@/components/incident/bits";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/form";
import { Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day, words } from "@/lib/format";
import { useAction, useIncident } from "@/lib/incident-context";
import { RULES } from "@/lib/labels";
import type { ExtractionOutput } from "@/lib/types";

/** The notice text with every quoted passage highlighted; red where the quote says "not affected". */
function NoticeText({ body, output }: { body: string; output: ExtractionOutput | null }) {
  const marks: Array<{ at: number; end: number; no: boolean }> = [];
  const add = (quote: string, no: boolean) => {
    const at = quote ? body.indexOf(quote) : -1;
    if (at >= 0) marks.push({ at, end: at + quote.length, no });
  };
  if (output) {
    output.products.forEach((p) => add(p.quote, !p.included));
    output.batchCodes.forEach((b) => add(b.quote, !b.affected));
    output.remedy.forEach((r) => add(r.quote, false));
    output.dates.forEach((d) => add(d.quote, false));
  }
  marks.sort((a, b) => a.at - b.at);
  const parts: ReactNode[] = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    if (m.at < cursor) return;
    parts.push(body.slice(cursor, m.at));
    parts.push(
      <mark key={i} className={m.no ? "rounded bg-muted px-0.5 text-muted-foreground line-through" : "rounded bg-hold/20 px-0.5 text-foreground"}>
        {body.slice(m.at, m.end)}
      </mark>,
    );
    cursor = m.end;
  });
  parts.push(body.slice(cursor));
  return (
    <div
      tabIndex={0}
      className="max-h-[32rem] overflow-y-auto rounded-lg border bg-card p-5 font-serif text-sm leading-relaxed whitespace-pre-wrap"
      aria-label="Supplier notice"
    >
      {parts}
    </div>
  );
}

function AddNotice() {
  const { incUrl } = useIncident();
  const { run, pending } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(
      () => api.post(`${incUrl}/documents`, { kind: "supplier_notice", title: String(f.get("title") || "Supplier notice"), body: String(f.get("body")) }),
      "The notice is attached. Read it next.",
    );
  };
  return (
    <Panel title="Add the supplier's notice" hint="Paste the text of the notice. It is stored as written and read into rules you check.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Notice title" name="title" maxLength={200} placeholder="Safety recall notice" />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="notice-body">Notice text</Label>
          <Textarea id="notice-body" name="body" rows={10} required minLength={20} maxLength={60000} />
        </div>
        <Button type="submit" className="w-fit" disabled={pending}>
          Attach the notice
        </Button>
      </form>
    </Panel>
  );
}

const Quote = ({ children }: { children: ReactNode }) => <p className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground italic">“{children}”</p>;

export default function NoticeStep() {
  const { map, evidence, incUrl } = useIncident();
  const { run, pending } = useAction();
  const m = map.data!;
  const ev = evidence.data!;
  const doc = ev.documents[0];
  const extraction = ev.extractions[0] ?? null;
  const out = extraction?.output ?? null;

  const [skus, setSkus] = useState<string | null>(null);
  const [batches, setBatches] = useState<string | null>(null);
  const [rule, setRule] = useState("full_refund");
  const skuValue = skus ?? out?.proposedScope?.skus.join(", ") ?? "";
  const batchValue = batches ?? out?.proposedScope?.batchCodes.join(", ") ?? "";

  const read = (method: "auto" | "pattern_rules") =>
    run(
      () => api.post(`${incUrl}/documents/${doc!.id}/extract`, { method }),
      "The notice was read. Check each line against the notice before saving any rules.",
    );

  const save = () => {
    const list = (s: string) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const scope = { type: "product", skus: list(skuValue), batchCodes: list(batchValue) };
    const compensation = RULES[rule]!.rule;
    const proposed = ev.extractions.find((e) => e.status === "proposed");
    return run(
      () =>
        proposed
          ? api.post(`${incUrl}/extractions/${proposed.id}/accept`, { scope, compensation })
          : api.post(`${incUrl}/rules`, { scope, compensation, note: "Entered by hand." }),
      "Rules saved in your name.",
    );
  };

  const by = extraction
    ? extraction.method === "pattern_rules"
      ? "Read by pattern rules, no AI"
      : `Read by ${extraction.method === "gemini" ? "Gemini" : extraction.method} (${extraction.model})`
    : "";

  return (
    <>
      <StepIntro question="Step 1" title="What went wrong?" hint="The supplier knows which batch is faulty. Nobody yet knows which customers received it." />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-sm">{m.incident.description}</p>
          {doc ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {doc.title}
                {doc.data_label === "synthetic" ? <Tag tone="hold">synthetic document</Tag> : null}
              </div>
              <NoticeText body={doc.body} output={out} />
            </>
          ) : (
            <AddNotice />
          )}
        </div>

        <div className="flex flex-col gap-4">
          {doc && !extraction ? (
            <Panel
              title="Read the notice"
              hint="Pull out which products and batches the supplier names. Every line will quote the notice, and nothing is applied until you save it."
            >
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => read("auto")} disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : null}
                  {ev.ai.configured ? `Read it with ${ev.ai.model}` : "Read it"}
                </Button>
                {ev.ai.configured ? (
                  <Button variant="outline" onClick={() => read("pattern_rules")} disabled={pending}>
                    Read it with pattern rules
                  </Button>
                ) : null}
              </div>
              {!ev.ai.configured ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  No AI key is set on this server, so the notice is read with plain text rules against your catalogue. The check on the result is the same
                  either way.
                </p>
              ) : null}
            </Panel>
          ) : null}

          {out ? (
            <Panel
              testId="notice-reading"
              title="What the notice says"
              hint={`${by}. Each line was checked: it quotes the notice word for word, and its value is inside the quote.`}
            >
              <Row label="Products">
                {out.products.length === 0 ? <span className="text-muted-foreground">none found</span> : null}
                {out.products.map((p) => (
                  <div key={p.code + p.quote} className="mb-2">
                    <span className="font-semibold">{p.code}</span> <Tag tone={p.included ? "stop" : "neutral"}>{p.included ? "affected" : "not affected"}</Tag>{" "}
                    {!p.inCatalogue ? <Tag tone="hold">not in your catalogue</Tag> : null}
                    <Quote>{p.quote}</Quote>
                  </div>
                ))}
              </Row>
              <Row label="Batches">
                {out.batchCodes.length === 0 ? <span className="text-muted-foreground">none found</span> : null}
                {out.batchCodes.map((b) => (
                  <div key={b.code + b.quote} className="mb-2">
                    <span className="font-semibold">{b.code}</span> <Tag tone={b.affected ? "stop" : "neutral"}>{b.affected ? "affected" : "not affected"}</Tag>
                    <Quote>{b.quote}</Quote>
                  </div>
                ))}
              </Row>
              {out.remedy.length > 0 ? (
                <Row label="Remedy">
                  {out.remedy.map((r) => (
                    <div key={r.quote} className="mb-2">
                      <span className="font-semibold">{words(r.kind)}</span>
                      <Quote>{r.quote}</Quote>
                    </div>
                  ))}
                </Row>
              ) : null}
              {out.dates.length > 0 ? (
                <Row label="Dates">
                  {out.dates.map((d) => (
                    <div key={d.quote} className="mb-2">
                      <span className="font-semibold">
                        {d.from} to {d.to}
                      </span>{" "}
                      <Tag>{words(d.meaning)}</Tag>
                      <Quote>{d.quote}</Quote>
                    </div>
                  ))}
                </Row>
              ) : null}
              {out.dropped.map((d) => (
                <p key={d.field + d.value} className="mt-2 text-sm text-destructive">
                  Dropped: {d.field} “{d.value}”. {d.why}
                </p>
              ))}
              {out.warnings.map((w) => (
                <p key={w} className="mt-2 text-sm text-hold">
                  {w}
                </p>
              ))}
            </Panel>
          ) : null}

          {m.rule ? (
            <Panel title={`Rules in force, version ${m.rule.version}`}>
              <Row label="Products">{m.rule.scope.skus.join(", ")}</Row>
              <Row label="Batches">{(m.rule.scope.batchCodes ?? []).join(", ") || "every unit"}</Row>
              <Row label="Owed">{m.rule.compensationInWords}</Row>
              <Row label="Saved by">
                {extraction?.decided_by ?? "a member of staff"}, {day(m.rule.created_at)}
              </Row>
            </Panel>
          ) : (
            <Panel
              title="Save the rules"
              hint={
                out
                  ? "These become the incident's rules in your name. Change them if the reading is wrong."
                  : "Or enter them by hand: the product codes and batch codes the supplier names. They become the incident's rules in your name."
              }
            >
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <Field label="Affected product codes" value={skuValue} onChange={(e) => setSkus(e.target.value)} />
                <Field label="Affected batch codes" value={batchValue} onChange={(e) => setBatches(e.target.value)} />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rule">What each affected customer is owed</Label>
                  <Select id="rule" value={rule} onChange={(e) => setRule(e.target.value)}>
                    {Object.entries(RULES).map(([k, r]) => (
                      <option key={k} value={k}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit" className="w-fit" disabled={pending}>
                  Save these rules
                </Button>
              </form>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
