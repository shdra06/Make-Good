"use client";

import type { Me, Membership } from "@makegood/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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

/** The organisation being worked on. One per user for now; the first is used. */
export function useOrg(): Membership | null {
  const { data } = useMe();
  return data?.organisations[0] ?? null;
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
