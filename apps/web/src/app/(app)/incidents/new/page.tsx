"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/form";
import { Alert, Card, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { KIND_LABELS } from "@/lib/incidents";
import { allowed, useOrgAction } from "@/lib/org-action";
import { orgPath, useOrg } from "@/lib/session";

export default function NewIncidentPage() {
  const org = useOrg();
  const router = useRouter();
  const { run, pending } = useOrgAction([["incidents", org?.orgId]]);
  const [kind, setKind] = useState("recall");

  if (!org) return null;
  if (!allowed(org.permissions, "incident.write")) {
    return (
      <>
        <PageHeader title="Open an incident" />
        <Alert tone="hold">Your role cannot open incidents. Ask an owner, admin or operator.</Alert>
      </>
    );
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const noticeTitle = String(f.get("noticeTitle") ?? "").trim();
    const noticeBody = String(f.get("noticeBody") ?? "").trim();
    const created = await run(async () => {
      if (noticeBody && noticeBody.length < 20) throw new Error("The notice is too short to read. Paste the whole text, or leave it empty and add it later.");
      const incident = await api.post<{ id: string }>(orgPath(org, "/incidents"), {
        kind,
        title: String(f.get("title")),
        description: String(f.get("description") ?? ""),
      });
      if (noticeBody) {
        await api.post(orgPath(org, `/incidents/${incident.id}/documents`), {
          kind: "supplier_notice",
          title: noticeTitle || "Supplier notice",
          body: noticeBody,
        });
      }
      return incident;
    }, "Incident opened.");
    if (created) router.push(`/incidents/${created.id}/notice`);
  };

  return (
    <>
      <PageHeader title="Open an incident" description="One problem that may owe customers money. You can add the supplier's notice now or later." />
      <Card className="max-w-2xl p-6">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind">What happened</Label>
            <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
            {kind !== "recall" ? (
              <p className="text-xs text-muted-foreground">
                The step-by-step workflow is built for recalls. Other kinds can be recorded, but have fewer tools today.
              </p>
            ) : null}
          </div>
          <Field label="Title" name="title" required minLength={3} maxLength={200} placeholder="HM-300 hand mixer: batch B-2217 recalled" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">What you know so far</Label>
            <Textarea id="description" name="description" maxLength={5000} placeholder="Optional. Who told you, and what they said." />
          </div>
          <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">The supplier&apos;s notice (optional)</legend>
            <Field label="Notice title" name="noticeTitle" maxLength={200} placeholder="Safety recall notice KA-RN-2026-031" />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="noticeBody">Notice text</Label>
              <Textarea
                id="noticeBody"
                name="noticeBody"
                rows={8}
                maxLength={60000}
                placeholder="Paste the full text of the notice. It is read into rules you check."
              />
            </div>
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              Open the incident
            </Button>
            <Button asChild variant="ghost">
              <Link href="/incidents">Cancel</Link>
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
