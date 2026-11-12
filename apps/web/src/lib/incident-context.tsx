"use client";

// Everything one incident page needs, loaded once for all its tabs.
// While payments are moving, the data that changes is asked for again every
// 1.5 seconds; otherwise only after an action.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { BATCH_APPROVED, BATCH_DONE, BATCH_STARTED, LIVE_OP_STATES } from "./labels";
import { useOrg } from "./session";
import type {
  AuditResponse,
  BatchResponse,
  CandidateRow,
  EvidenceResponse,
  Evaluation,
  IncidentDetail,
  Manifest,
  Notices,
  Preview,
  Reconciliation,
  RecoveryMap,
} from "./types";

type Ctx = {
  orgUrl: string;
  incUrl: string;
  incidentId: string;
  map: UseQueryResult<RecoveryMap>;
  evidence: UseQueryResult<EvidenceResponse>;
  candidates: UseQueryResult<{ rows: CandidateRow[] }>;
  detail: UseQueryResult<IncidentDetail>;
  evaluation: UseQueryResult<Evaluation>;
  audit: UseQueryResult<AuditResponse | null>;
  reconciliation: UseQueryResult<Reconciliation>;
  notices: UseQueryResult<Notices | null>;
  preview: UseQueryResult<Preview>;
  batch: UseQueryResult<BatchResponse>;
  manifest: UseQueryResult<Manifest | null>;
  progress: Progress;
  live: boolean;
  refresh: () => Promise<void>;
};

export type Progress = { rules: boolean; matched: boolean; listed: boolean; approved: boolean; started: boolean; paid: boolean; told: boolean };

const IncidentCtx = createContext<Ctx | null>(null);

export function useIncident(): Ctx {
  const ctx = useContext(IncidentCtx);
  if (!ctx) throw new Error("useIncident must be used inside an incident page.");
  return ctx;
}

export function IncidentProvider({ incidentId, children }: { incidentId: string; children: ReactNode }) {
  const org = useOrg();
  const client = useQueryClient();
  const orgUrl = `/api/orgs/${org?.orgId ?? "_"}`;
  const incUrl = `${orgUrl}/incidents/${incidentId}`;
  const key = (name: string, ...rest: unknown[]) => ["incident", org?.orgId, incidentId, name, ...rest];
  const enabled = org !== null;

  const detail = useQuery({ queryKey: key("detail"), queryFn: () => api.get<IncidentDetail>(incUrl), enabled });
  const current = detail.data?.batches.find((b) => !["cancelled", "rejected"].includes(b.status)) ?? null;

  const batch = useQuery({
    queryKey: key("batch", current?.id),
    queryFn: () => api.get<BatchResponse>(`${orgUrl}/batches/${current!.id}?size=200`),
    enabled: enabled && current !== null,
    refetchInterval: (q) => {
      const b = q.state.data;
      if (!b) return false;
      const moving = ["executing", "paused"].includes(b.batch.status) || b.operations.some((o) => LIVE_OP_STATES.includes(o.state));
      return moving ? 1500 : false;
    },
  });
  const live = Boolean(
    batch.data && (["executing", "paused"].includes(batch.data.batch.status) || batch.data.operations.some((o) => LIVE_OP_STATES.includes(o.state))),
  );
  const poll = live ? 1500 : false;

  const map = useQuery({ queryKey: key("map"), queryFn: () => api.get<RecoveryMap>(`${incUrl}/recovery-map`), enabled, refetchInterval: poll });
  const evidence = useQuery({ queryKey: key("evidence"), queryFn: () => api.get<EvidenceResponse>(`${incUrl}/evidence`), enabled });
  const candidates = useQuery({
    queryKey: key("candidates"),
    queryFn: () => api.get<{ rows: CandidateRow[] }>(`${incUrl}/candidates?size=200&includeCleared=true`),
    enabled,
    refetchInterval: poll,
  });
  const evaluation = useQuery({ queryKey: key("evaluation"), queryFn: () => api.get<Evaluation>(`${incUrl}/evaluation`), enabled, refetchInterval: poll });
  const audit = useQuery({
    queryKey: key("audit"),
    queryFn: () => api.get<AuditResponse>(`${orgUrl}/audit?size=60`).catch(() => null),
    enabled,
    refetchInterval: poll,
  });
  const reconciliation = useQuery({
    queryKey: key("reconciliation"),
    queryFn: () => api.get<Reconciliation>(`${orgUrl}/reconciliation`).catch(() => [] as Reconciliation),
    enabled,
    refetchInterval: poll,
  });
  const notices = useQuery({
    queryKey: key("notices"),
    queryFn: () => api.get<Notices>(`${incUrl}/notices`).catch(() => null),
    enabled,
    refetchInterval: poll,
  });
  const hasRule = Boolean(map.data?.rule);
  const preview = useQuery({
    queryKey: key("preview"),
    queryFn: () => api.get<Preview>(`${incUrl}/preview`),
    enabled: enabled && hasRule,
    refetchInterval: poll,
  });
  const manifest = useQuery({
    queryKey: key("manifest", current?.id),
    queryFn: () => api.get<Manifest>(`${orgUrl}/batches/${current!.id}/manifest`).catch(() => null),
    enabled: enabled && current !== null,
  });

  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ["incident", org?.orgId, incidentId] }), [client, org?.orgId, incidentId]);

  // When payments stop moving, load everything once more: the last outcomes,
  // settled differences and results are written as the run finishes.
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !live) void refresh();
    wasLive.current = live;
  }, [live, refresh]);

  const progress = useMemo<Progress>(() => {
    const b = batch.data?.batch;
    return {
      rules: hasRule,
      matched: Boolean(map.data?.lastMatch),
      listed: Boolean(b),
      approved: Boolean(b && BATCH_APPROVED.includes(b.status)),
      started: Boolean(b && BATCH_STARTED.includes(b.status)),
      paid: Boolean(b && BATCH_DONE.includes(b.status)),
      told: Boolean(notices.data?.items.some((n) => n.kind === "payment_sent")),
    };
  }, [batch.data, hasRule, map.data?.lastMatch, notices.data]);

  const value: Ctx = {
    orgUrl,
    incUrl,
    incidentId,
    map,
    evidence,
    candidates,
    detail,
    evaluation,
    audit,
    reconciliation,
    notices,
    preview,
    batch,
    manifest,
    progress,
    live,
    refresh,
  };
  return <IncidentCtx.Provider value={value}>{children}</IncidentCtx.Provider>;
}

/**
 * Runs one action against the API, then reloads the incident. Shows the
 * outcome as a toast: the given message on success, the API's own words on failure.
 */
export function useAction() {
  const { refresh } = useIncident();
  const mutation = useMutation({
    mutationFn: async ({ action }: { action: () => Promise<unknown>; done?: string | ((result: unknown) => string | null) }) => action(),
    onSuccess: async (result, { done }) => {
      await refresh();
      const message = typeof done === "function" ? done(result) : done;
      if (message) toast.success(message);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const run = useCallback(
    <T,>(action: () => Promise<T>, done?: string | ((result: T) => string | null)) =>
      mutation.mutateAsync({ action, done: done as string | ((result: unknown) => string | null) | undefined }).catch(() => undefined) as Promise<
        T | undefined
      >,
    [mutation],
  );
  return { run, pending: mutation.isPending };
}

/** The step to do next, as a tab path and words. */
export function nextStep(p: Progress, batchStatus: string | undefined): { tab: string; text: string } | null {
  if (!p.rules) return { tab: "notice", text: "Read the notice and save the rules" };
  if (!p.matched) return { tab: "customers", text: "Find affected customers" };
  if (!p.listed) return { tab: "approval", text: "Build the payment list" };
  if (!p.approved) return { tab: "approval", text: batchStatus === "draft" ? "Send the list for approval" : "Approve the list" };
  if (!p.started) return { tab: "payments", text: "Start paying" };
  if (!p.paid) return { tab: "payments", text: "Watch PayPal confirm each payment" };
  if (!p.told) return { tab: "payments", text: "Tell the customers PayPal has paid" };
  return null;
}
