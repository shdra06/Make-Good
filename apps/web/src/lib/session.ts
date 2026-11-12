"use client";

import type { Me, Membership } from "@makegood/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";

/** The signed-in user, or null when nobody is signed in. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/api/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

// The workspace being worked on is remembered in this browser only. It is a
// convenience: the API checks membership on every request.
const ORG_KEY = "mg_org";
const listeners = new Set<() => void>();
function readChosen(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}
export function chooseOrg(orgId: string) {
  try {
    localStorage.setItem(ORG_KEY, orgId);
  } catch {
    /* private window: the choice lasts until reload */
  }
  chosenFallback = orgId;
  listeners.forEach((l) => l());
}
let chosenFallback: string | null = null;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The organisation being worked on: the one chosen in this browser, else the first. */
export function useOrg(): Membership | null {
  const { data } = useMe();
  const chosen = useSyncExternalStore(
    subscribe,
    () => chosenFallback ?? readChosen(),
    () => null,
  );
  const orgs = data?.organisations ?? [];
  return orgs.find((o) => o.orgId === chosen) ?? orgs[0] ?? null;
}

export const orgPath = (org: Membership, path = "") => `/api/orgs/${org.orgId}${path}`;

export function useSignOut() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
    onSettled: () => {
      client.clear();
      router.replace("/sign-in");
    },
  });
}
