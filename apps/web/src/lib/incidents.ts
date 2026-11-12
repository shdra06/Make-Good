"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { orgPath, useOrg } from "./session";

/** One row of GET /api/orgs/:orgId/incidents. */
export type IncidentRow = {
  id: string;
  kind: string;
  title: string;
  status: string;
  claims_open: boolean;
  created_at: string;
  rule_version: number | null;
  confirmed: number;
  awaiting: number;
  paid: number;
  claims: number;
};

export function useIncidents() {
  const org = useOrg();
  return useQuery({
    queryKey: ["incidents", org?.orgId],
    queryFn: () => api.get<IncidentRow[]>(orgPath(org!, "/incidents")),
    enabled: org !== null,
  });
}

export const KIND_LABELS: Record<string, string> = {
  product_defect: "Product defect",
  recall: "Product recall",
  overcharge: "Overcharge",
  duplicate_charge: "Duplicate charge",
  cancelled_event: "Cancelled event",
  subscription_error: "Subscription error",
  service_disruption: "Service disruption",
  failed_delivery: "Failed delivery",
  pricing_error: "Pricing error",
  other: "Other",
};

export const STATUS_TONE: Record<string, "neutral" | "ok" | "hold" | "info"> = { draft: "neutral", active: "info", closed: "ok", cancelled: "neutral" };

export const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
