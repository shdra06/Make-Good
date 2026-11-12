"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, FileText } from "lucide-react";
import { useState } from "react";
import { Panel, StepIntro } from "@/components/incident/bits";
import { Button } from "@/components/ui/button";
import { Table, Textarea } from "@/components/ui/form";
import { Alert, Badge, Label } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { day, money, time, words } from "@/lib/format";
import { useIncident } from "@/lib/incident-context";
import { allowed, useOrgAction } from "@/lib/org-action";
import { useOrg } from "@/lib/session";

type ClaimRow = {
  id: string;
  public_ref: string;
  claimant_name: string;
  claimant_email: string;
  status: string;
  declared: { orderNumber?: string };
  created_at: string;
  files: number;
};
type ClaimsResponse = { open: boolean; url: string | null; instructions: string | null; claims: ClaimRow[] };
type ClaimFile = { id: string; kind: string; original_name: string | null; mime: string; size_bytes: number };
type Match = {
  id: string;
  order_number: string;
  placed_at: string;
  total_minor: number;
  currency: string;
  how: string;
  candidate: { id: string; status: string; decision: string } | null;
};
type ClaimDetail = {
  id: string;
  public_ref: string;
  claimant_name: string;
  claimant_email: string;
  statement: string;
  status: string;
  created_at: string;
  declared: { orderNumber?: string; batchCode?: string };
  files: ClaimFile[];
  matches: Match[];
  events: { actor_kind: string; kind: string; body: string | null; created_at: string }[];
};

const STATUS_TONE: Record<string, "ok" | "hold" | "stop" | "info" | "neutral"> = {
  submitted: "info",
  under_review: "info",
  needs_evidence: "hold",
  approved: "ok",
  rejected: "stop",
  withdrawn: "neutral",
};

function ClaimSheet({ claimId, orgUrl, onClose }: { claimId: string; orgUrl: string; onClose: () => void }) {
  const key = ["claim", claimId];
  const claim = useQuery({ queryKey: key, queryFn: () => api.get<ClaimDetail>(`${orgUrl}/claims/${claimId}`) });
  const { run, pending } = useOrgAction([key, ["claims"]]);
  const [note, setNote] = useState("");
  const decide = (decision: "approve" | "reject" | "needs_evidence", done: string) =>
    void run(() => api.post(`${orgUrl}/claims/${claimId}/decision`, { decision, note }), done).then((r) => {
      if (r) setNote("");
    });
  const c = claim.data;
  const open = c && ["submitted", "under_review", "needs_evidence"].includes(c.status);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={c ? `${c.claimant_name} · ${c.public_ref}` : "Claim"} description="A customer's claim">
      {claim.isPending ? (
        <TableSkeleton rows={3} />
      ) : claim.isError ? (
        <Alert>{claim.error.message}</Alert>
      ) : (
        <div className="flex flex-col gap-5 text-sm" data-testid="claim-sheet">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[c!.status] ?? "neutral"}>{words(c!.status)}</Badge>
            <span className="text-muted-foreground">
              {c!.claimant_email} · sent {time(c!.created_at)}
            </span>
          </div>
          <div>
            <p className="font-medium">What they say</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c!.statement}</p>
            <p className="mt-2 text-muted-foreground">
              Order number: <strong className="text-foreground">{c!.declared.orderNumber || "not given"}</strong> · Batch code:{" "}
              <strong className="text-foreground">{c!.declared.batchCode || "not given"}</strong>
            </p>
          </div>
          <div>
            <p className="mb-2 font-medium">Files ({c!.files.length})</p>
            {c!.files.length === 0 ? (
              <p className="text-muted-foreground">No files yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {c!.files.map((f) => {
                  const href = `${orgUrl}/claims/${claimId}/files/${f.id}`;
                  return (
                    <a key={f.id} href={href} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-lg border">
                      {f.mime.startsWith("image/") ? (
                        // A customer's photo, served from our own API: next/image would add nothing here.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={href} alt={`${words(f.kind)} sent by the customer`} className="aspect-video w-full bg-muted object-contain" />
                      ) : (
                        <div className="grid aspect-video place-items-center bg-muted">
                          <FileText className="size-8 text-muted-foreground" />
                        </div>
                      )}
                      <p className="truncate px-2 py-1 text-xs text-muted-foreground group-hover:text-foreground">
                        {words(f.kind)} · {Math.ceil(f.size_bytes / 1024)} KB
                      </p>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 font-medium">Orders it may be about</p>
            {c!.matches.length === 0 ? (
              <Alert tone="hold">No order matches the order number or the email. The shop&apos;s records do not show this customer.</Alert>
            ) : (
              <ul className="flex flex-col gap-2">
                {c!.matches.map((m) => (
                  <li key={m.id} className="rounded-lg border p-3">
                    <p>
                      Order <strong>{m.order_number}</strong> · {day(m.placed_at)} · {money(m.total_minor, m.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Matched by {m.how}.{" "}
                      {m.candidate
                        ? `In this recall: ${words(m.candidate.status)}, ${words(m.candidate.decision)}.`
                        : "Not among this recall's customer records."}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {open ? (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <Label htmlFor="claim-note">Message to the customer</Label>
              <Textarea
                id="claim-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Needed to reject or to ask for more. They read it on their status page and by email."
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={() => decide("approve", "Claim accepted. Decide the customer's record as usual.")}>
                  Accept
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => decide("needs_evidence", "Asked the customer for more evidence.")}>
                  Ask for more
                </Button>
                <Button size="sm" variant="destructive" disabled={pending} onClick={() => decide("reject", "Claim rejected.")}>
                  Reject
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Accepting pays nobody. It links the claim to the customer record, which still goes through approval.
              </p>
            </div>
          ) : null}
          <div>
            <p className="mb-2 font-medium">History</p>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {c!.events.map((e, i) => (
                <li key={i}>
                  {time(e.created_at)} · {words(e.kind)}
                  {e.body ? `: ${e.body}` : ""}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export default function ClaimsStep() {
  const { orgUrl, incUrl } = useIncident();
  const org = useOrg();
  const claims = useQuery({ queryKey: ["claims", incUrl], queryFn: () => api.get<ClaimsResponse>(`${incUrl}/claims`) });
  const { run, pending } = useOrgAction([["claims", incUrl]]);
  const [openId, setOpenId] = useState<string | null>(null);
  const canOpen = allowed(org?.permissions, "incident.write");
  const d = claims.data;

  return (
    <>
      <StepIntro
        question="Customers the records miss"
        title="Claims"
        hint="Open a public form where customers can say they bought an affected unit, with a photo of the receipt or label. You decide each one."
      />
      <div className="flex flex-col gap-6">
        <Panel
          title={d?.open ? "The claim form is open" : "The claim form is closed"}
          actions={
            canOpen && d ? (
              <Button
                size="sm"
                variant={d.open ? "outline" : "default"}
                disabled={pending}
                onClick={() => void run(() => api.post(`${incUrl}/claims/open`, { open: !d.open }), d.open ? "Claim form closed." : "Claim form opened.")}
              >
                {d.open ? "Close the form" : "Open the claim form"}
              </Button>
            ) : null
          }
          testId="claim-form-panel"
        >
          {d?.open && d.url ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs" data-testid="claim-url">
                {d.url}
              </code>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(d.url!)}>
                <Copy /> Copy
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Share the link on your site, in emails or on the recall notice once it is open.</p>
          )}
        </Panel>
        <Panel title={`Claims${d ? ` (${d.claims.length})` : ""}`} testId="claims">
          {claims.isPending ? (
            <TableSkeleton rows={2} />
          ) : claims.isError ? (
            <Alert>{claims.error.message}</Alert>
          ) : d!.claims.length === 0 ? (
            <p className="text-sm text-muted-foreground">No claims yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Order</th>
                  <th>Files</th>
                  <th>Status</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {d!.claims.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setOpenId(c.id)}>
                    <td>
                      <button className="font-medium hover:underline" onClick={() => setOpenId(c.id)}>
                        {c.claimant_name}
                      </button>
                      <p className="text-xs text-muted-foreground">{c.claimant_email}</p>
                    </td>
                    <td>{c.declared?.orderNumber || "–"}</td>
                    <td>{c.files}</td>
                    <td>
                      <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{words(c.status)}</Badge>
                    </td>
                    <td className="text-muted-foreground">{day(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
      {openId ? <ClaimSheet claimId={openId} orgUrl={orgUrl} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}
