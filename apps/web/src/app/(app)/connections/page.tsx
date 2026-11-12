"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Plug, RefreshCw, Store, Unplug, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CsvUpload } from "@/components/csv-upload";
import { Field } from "@/components/field";
import { Panel, Tag } from "@/components/incident/bits";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Select, Table } from "@/components/ui/form";
import { Alert, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day, time, words } from "@/lib/format";
import { allowed, useOrgAction } from "@/lib/org-action";
import { orgPath, useMe, useOrg } from "@/lib/session";

type Connection = {
  id: string;
  environment: "sandbox" | "live" | "simulator";
  mode: "first_party" | "partner" | "simulator";
  status: "pending" | "connected" | "invalid" | "revoked";
  clientIdMasked: string | null;
  merchantId: string | null;
  webhookConfigured: boolean;
  capabilities: { refunds?: boolean; transactionSearch?: boolean; payouts?: boolean; disputes?: boolean; webhooks?: boolean };
  lastVerifiedAt: string | null;
  lastError: string | null;
};
type StoreRow = { id: string; kind: string; name: string; status: string; last_synced_at: string | null; last_error: string | null; orders: number };
type SyncRun = {
  id: string;
  source: string;
  status: string;
  window_start: string | null;
  window_end: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

const CAPABILITIES: Array<[keyof Connection["capabilities"], string]> = [
  ["refunds", "Refunds"],
  ["transactionSearch", "Transaction Search"],
  ["payouts", "Payouts"],
  ["disputes", "Disputes"],
  ["webhooks", "Webhooks"],
];

function Capability({ on, label }: { on: boolean | undefined; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      {on ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <XCircle className="size-4 text-muted-foreground" aria-hidden />}
      {label}
      <span className="sr-only">{on ? "available" : "not available"}</span>
    </span>
  );
}

function PayPalSection({ canManage, canImport }: { canManage: boolean; canImport: boolean }) {
  const org = useOrg()!;
  const me = useMe();
  const server = me.data?.server;
  const key = ["paypal", org.orgId];
  const paypal = useQuery({ queryKey: key, queryFn: () => api.get<{ connections: Connection[]; active: Connection | null }>(orgPath(org, "/paypal")) });
  const runs = useQuery({ queryKey: ["sync-runs", org.orgId], queryFn: () => api.get<SyncRun[]>(orgPath(org, "/sync-runs")) });
  const { run, pending } = useOrgAction([key, ["sync-runs", org.orgId]]);
  const [environment, setEnvironment] = useState<"sandbox" | "live">("sandbox");

  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    void run(
      () =>
        api.post(orgPath(org, "/paypal/credentials"), {
          environment,
          clientId: String(f.get("clientId")).trim(),
          clientSecret: String(f.get("clientSecret")).trim(),
          webhookId: String(f.get("webhookId") ?? "").trim() || null,
        }),
      "Connected. PayPal confirmed the credentials; the secret is stored encrypted and never shown again.",
    ).then((r) => {
      if (r) form.reset();
    });
  };

  const active = paypal.data?.active ?? null;
  const shown = (paypal.data?.connections ?? []).filter((c) => c.status !== "revoked");

  return (
    <Panel
      title="PayPal"
      hint="Where refunds are sent. Make Good uses the merchant's own PayPal REST app; the secret is encrypted at rest and only the last characters of the client ID are ever shown."
    >
      {paypal.isPending ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : paypal.isError ? (
        <Alert>{paypal.error.message}</Alert>
      ) : (
        <div className="flex flex-col gap-5">
          {shown.length === 0 ? <p className="text-sm text-muted-foreground">No PayPal account is connected.</p> : null}
          {shown.map((c) => (
            <div key={c.id} className="rounded-lg border p-4" data-testid="paypal-connection">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">
                  {c.environment === "simulator" ? "Built-in simulator" : `PayPal ${c.environment}`}
                  {c.clientIdMasked ? <span className="ml-2 font-mono text-xs text-muted-foreground">{c.clientIdMasked}</span> : null}
                </span>
                <Tag tone={c.status === "connected" ? "ok" : c.status === "invalid" ? "stop" : "hold"}>{c.status}</Tag>
                {active?.id === c.id ? <Tag tone="info">in use</Tag> : null}
                {c.environment === "simulator" ? (
                  <Tag tone="hold">no real money</Tag>
                ) : c.environment === "sandbox" ? (
                  <Tag tone="info">test money</Tag>
                ) : (
                  <Tag tone="stop">real money</Tag>
                )}
                {canManage ? (
                  <div className="ml-auto flex gap-2">
                    {c.environment !== "simulator" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => void run(() => api.post(orgPath(org, `/paypal/${c.id}/verify`)), "PayPal was asked again.")}
                      >
                        <RefreshCw /> Check again
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm("Disconnect this PayPal account? The stored secret is wiped. Payments already made are not affected.")) {
                          void run(() => api.delete(orgPath(org, `/paypal/${c.id}`)), "Disconnected. The stored secret was wiped.");
                        }
                      }}
                    >
                      <Unplug /> Disconnect
                    </Button>
                  </div>
                ) : null}
              </div>
              {c.environment !== "simulator" ? (
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                  {CAPABILITIES.map(([k, label]) => (
                    <Capability key={k} on={c.capabilities[k]} label={label} />
                  ))}
                  <Capability on={c.webhookConfigured} label="Webhook ID set" />
                </div>
              ) : null}
              {c.environment !== "simulator" && c.capabilities.transactionSearch === false ? (
                <p className="mt-3 text-sm text-hold">
                  Transaction Search is off for this PayPal app, so past payments cannot be copied in bulk. Switch it on in the PayPal developer dashboard, then
                  press Check again. Payments that orders name can still be fetched one by one.
                </p>
              ) : null}
              {c.lastError ? <p className="mt-2 text-sm text-destructive">{c.lastError}</p> : null}
              {c.lastVerifiedAt ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Last checked {day(c.lastVerifiedAt)} {time(c.lastVerifiedAt)}
                </p>
              ) : null}
            </div>
          ))}

          {active && canImport && active.environment !== "simulator" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(() => api.post(orgPath(org, "/paypal/sync"), { days: 90 }), "Copying the last 90 days of PayPal transactions in the background.")
                }
              >
                Copy the last 90 days from PayPal
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void run(() => api.post(orgPath(org, "/paypal/lookup-payments"), {}), "PayPal was asked for each payment that an order names.")}
              >
                Fetch the payments orders name
              </Button>
            </div>
          ) : null}

          {canManage ? (
            <form onSubmit={connect} className="flex flex-col gap-4 rounded-lg border border-dashed p-4" autoComplete="off">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Plug className="size-4" aria-hidden /> Connect a PayPal REST app
              </h3>
              <p className="text-sm text-muted-foreground">
                From developer.paypal.com, Apps &amp; Credentials. Use a sandbox app to try it with test money. Connecting replaces the connection in use.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pp-env">Environment</Label>
                <Select id="pp-env" value={environment} onChange={(e) => setEnvironment(e.target.value as "sandbox" | "live")}>
                  <option value="sandbox">Sandbox (test money)</option>
                  <option value="live" disabled={!server?.livePayPalAllowed}>
                    Live (real money){server?.livePayPalAllowed ? "" : ": switched off on this server"}
                  </option>
                </Select>
              </div>
              <Field label="Client ID" name="clientId" required maxLength={200} spellCheck={false} />
              <Field label="Secret" name="clientSecret" type="password" required maxLength={200} autoComplete="new-password" />
              <Field label="Webhook ID" name="webhookId" maxLength={100} hint="Optional. Lets PayPal tell Make Good when a refund or dispute changes." />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={pending}>
                  Connect
                </Button>
                {server?.simulatorAllowed ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void run(() => api.post(orgPath(org, "/paypal/simulator")), "The built-in simulator is in use. No real calls, no real money.")
                    }
                  >
                    Use the built-in simulator instead
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}

          {runs.data && runs.data.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Recent copies</h3>
              <Table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>What</th>
                    <th>Status</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.slice(0, 8).map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap tabular-nums">
                        {day(r.started_at)} {time(r.started_at)}
                      </td>
                      <td>{words(r.source)}</td>
                      <td>
                        <Tag tone={r.status === "succeeded" ? "ok" : r.status === "failed" ? "stop" : "info"}>{r.status}</Tag>
                      </td>
                      <td className="text-xs text-muted-foreground">{r.error ?? (r.window_start ? `${day(r.window_start)} to ${day(r.window_end)}` : "")}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function StoresSection({ canManage, canImport }: { canManage: boolean; canImport: boolean }) {
  const org = useOrg()!;
  const key = ["stores", org.orgId];
  const stores = useQuery({ queryKey: key, queryFn: () => api.get<StoreRow[]>(orgPath(org, "/stores")) });
  const { run, pending } = useOrgAction([key]);

  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name")).trim();
    void run(() => api.post(orgPath(org, "/stores"), { name, kind: "csv" }), `"${name}" added. Upload its orders as a spreadsheet.`).then((r) => {
      if (r) form.reset();
    });
  };

  return (
    <Panel
      title="Stores and orders"
      hint="Where the orders come from. Orders arrive by spreadsheet (CSV) or through the import API. Shopify and WooCommerce connectors are not built yet."
    >
      {stores.isPending ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : stores.isError ? (
        <Alert>{stores.error.message}</Alert>
      ) : (
        <div className="flex flex-col gap-5">
          {stores.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No store yet.</p>
          ) : (
            <Table data-testid="stores">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>How orders arrive</th>
                  <th className="text-right">Orders</th>
                  <th>Last import</th>
                </tr>
              </thead>
              <tbody>
                {stores.data.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium">
                      <Store className="mr-1 inline size-4 text-muted-foreground" aria-hidden />
                      {s.name}
                    </td>
                    <td>{s.kind === "csv" ? "Spreadsheet" : s.kind === "custom" ? "Import API" : s.kind}</td>
                    <td className="text-right tabular-nums">{s.orders}</td>
                    <td className="text-muted-foreground">{s.last_synced_at ? `${day(s.last_synced_at)} ${time(s.last_synced_at)}` : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {canManage ? (
            <form onSubmit={add} className="flex flex-wrap items-end gap-2">
              <div className="min-w-60 flex-1">
                <Field label="Add a store" name="name" required minLength={2} maxLength={120} placeholder="Main web shop" />
              </div>
              <Button type="submit" variant="outline" disabled={pending}>
                Add store
              </Button>
            </form>
          ) : null}
          {canImport && stores.data.length > 0 ? <CsvUpload orgUrl={orgPath(org)} onImported={() => void stores.refetch()} /> : null}
        </div>
      )}
    </Panel>
  );
}

export default function ConnectionsPage() {
  const org = useOrg();
  if (!org) return null;
  const canManage = allowed(org.permissions, "connections.manage");
  const canImport = allowed(org.permissions, "data.import");
  return (
    <>
      <PageHeader title="Connections" description="PayPal, for sending refunds, and your stores, for the orders." />
      {!canManage ? (
        <Alert tone="info" className="mb-5">
          Only an owner or admin can change connections. You can see them.
        </Alert>
      ) : null}
      <div className="flex flex-col gap-6">
        <PayPalSection canManage={canManage} canImport={canImport} />
        <StoresSection canManage={canManage} canImport={canImport} />
      </div>
    </>
  );
}
