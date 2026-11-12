"use client";

import type { Membership } from "@makegood/shared";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Panel, Row } from "@/components/incident/bits";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Alert, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { allowed, useOrgAction } from "@/lib/org-action";
import { orgPath, useOrg } from "@/lib/session";

type Settings = {
  approval: { dualControl: boolean; approvalsRequired: number; largeBatchMinor: number | null; largeBatchApprovalsRequired: number };
  fxAssumedSpreadBps: number | null;
  demoData: boolean;
};

function ApprovalForm({ org, settings, canManage }: { org: Membership; settings: Settings; canManage: boolean }) {
  const { run, pending } = useOrgAction([["org", org.orgId], ["me"]]);
  const a = settings.approval;
  const [dual, setDual] = useState(a.dualControl);
  const [required, setRequired] = useState(String(a.approvalsRequired));
  const [large, setLarge] = useState(a.largeBatchMinor === null ? "" : (a.largeBatchMinor / 100).toFixed(2));
  const [largeRequired, setLargeRequired] = useState(String(a.largeBatchApprovalsRequired));
  const [spread, setSpread] = useState(settings.fxAssumedSpreadBps === null ? "" : (settings.fxAssumedSpreadBps / 100).toString());

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const largeMinor = large.trim() === "" ? null : Math.round(Number(large) * 100);
      if (largeMinor !== null && (!Number.isFinite(largeMinor) || largeMinor <= 0))
        throw new Error("The large-list threshold must be an amount above zero, or empty.");
      const spreadBps = spread.trim() === "" ? null : Math.round(Number(spread) * 100);
      if (spreadBps !== null && (!Number.isFinite(spreadBps) || spreadBps < 0 || spreadBps > 2000))
        throw new Error("The conversion cost must be between 0 and 20 percent, or empty.");
      return api.patch(orgPath(org, "/settings"), {
        approval: { dualControl: dual, approvalsRequired: Number(required), largeBatchMinor: largeMinor, largeBatchApprovalsRequired: Number(largeRequired) },
        fxAssumedSpreadBps: spreadBps,
      });
    }, "Settings saved. The change is on the audit trail.");
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      <fieldset disabled={!canManage || pending} className="flex flex-col gap-5">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 size-4" checked={dual} onChange={(e) => setDual(e.target.checked)} />
          <span>
            <span className="block text-sm font-medium">Four-eyes rule</span>
            <span className="block text-sm text-muted-foreground">The person who builds a payment list cannot approve it.</span>
          </span>
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="required">Approvals needed for a payment list</Label>
            <Select id="required" value={required} onChange={(e) => setRequired(e.target.value)}>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="large-required">Approvals needed for a large list</Label>
            <Select id="large-required" value={largeRequired} onChange={(e) => setLargeRequired(e.target.value)}>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <Field
            label={`A list is large above (${org.defaultCurrency})`}
            inputMode="decimal"
            value={large}
            onChange={(e) => setLarge(e.target.value)}
            placeholder="No threshold"
            hint={a.largeBatchMinor ? `Now: ${money(a.largeBatchMinor, org.defaultCurrency)}` : "Empty means every list needs the same number of approvals."}
          />
          <Field
            label="Assumed currency-conversion cost (%)"
            inputMode="decimal"
            value={spread}
            onChange={(e) => setSpread(e.target.value)}
            placeholder="Not shown"
            hint="For forecasts only. It never changes what is paid."
          />
        </div>
      </fieldset>
      {canManage ? (
        <Button type="submit" className="w-fit" disabled={pending}>
          Save settings
        </Button>
      ) : null}
    </form>
  );
}

export default function SettingsPage() {
  const org = useOrg();
  const detail = useQuery({
    queryKey: ["org", org?.orgId],
    queryFn: () => api.get<Membership & { settings: Settings }>(orgPath(org!)),
    enabled: org !== null,
  });
  if (!org) return null;
  const canManage = allowed(org.permissions, "org.manage");

  return (
    <>
      <PageHeader title="Settings" description="How this workspace approves payments." />
      {!canManage ? (
        <Alert tone="info" className="mb-5">
          Only an owner or admin can change settings. You can see them.
        </Alert>
      ) : null}
      <div className="flex flex-col gap-6">
        <Panel title="Workspace">
          <Row label="Name">{org.name}</Row>
          <Row label="Currency">{org.defaultCurrency}</Row>
          <Row label="Address">{org.slug}</Row>
        </Panel>
        <Panel title="Approvals" hint="Every payment list is approved as one exact, versioned list. These rules say how many people must approve it.">
          {detail.isPending ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
          ) : detail.isError ? (
            <Alert>{detail.error.message}</Alert>
          ) : (
            <ApprovalForm key={JSON.stringify(detail.data.settings)} org={org} settings={detail.data.settings} canManage={canManage} />
          )}
        </Panel>
      </div>
    </>
  );
}
