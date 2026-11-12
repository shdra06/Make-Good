"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

/**
 * Runs one action against the API, reloads the given data, and reports the
 * outcome as a toast: the given words on success, the API's own words on failure.
 */
export function useOrgAction(reload: QueryKey[] = []) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ action }: { action: () => Promise<unknown>; done?: string | ((r: unknown) => string | null) }) => action(),
    onSuccess: async (result, { done }) => {
      await Promise.all(reload.map((queryKey) => client.invalidateQueries({ queryKey })));
      const message = typeof done === "function" ? done(result) : done;
      if (message) toast.success(message);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const run = useCallback(
    <T>(action: () => Promise<T>, done?: string | ((r: T) => string | null)) =>
      mutation.mutateAsync({ action, done: done as string | ((r: unknown) => string | null) | undefined }).catch(() => undefined) as Promise<T | undefined>,
    [mutation],
  );
  return { run, pending: mutation.isPending };
}

/** True when the signed-in user's role allows this. The API checks again; this only hides what would be refused. */
export function allowed(permissions: string[] | undefined, permission: string): boolean {
  return Boolean(permissions?.includes(permission));
}
