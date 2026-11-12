"use client";

import type { Me } from "@makegood/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { api } from "@/lib/api";

/**
 * Creates a throw-away demo workspace: a demo user, a shop on the built-in
 * PayPal simulator, and the synthetic HM-300 recall case. No real money.
 */
export function DemoButton({ size = "lg" }: { size?: "lg" | "default" }) {
  const router = useRouter();
  const client = useQueryClient();
  const start = useMutation({
    mutationFn: async () => {
      const id = Math.random().toString(36).slice(2, 10);
      await api.post("/api/auth/register", { email: `demo-${id}@example.com`, password: `${crypto.randomUUID()}-Demo`, name: "Ada (demo)" });
      const org = await api.post<{ id: string }>("/api/orgs", { name: `Kitchen Co ${id}` });
      await api.post(`/api/orgs/${org.id}/paypal/simulator`);
      const seeded = await api.post<{ incidentId: string }>(`/api/orgs/${org.id}/demo/recall-scenario`);
      return seeded.incidentId;
    },
    onSuccess: async (incidentId) => {
      await client.invalidateQueries({ queryKey: ["me"] });
      await client.fetchQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
      router.push(`/incidents/${incidentId}`);
    },
  });
  return (
    <div className="flex flex-col gap-2">
      <Button size={size} onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? <Loader2 className="animate-spin" /> : null}
        {start.isPending ? "Setting up the demo shop…" : "Open the recall demo"}
        {start.isPending ? null : <ArrowRight />}
      </Button>
      {start.error ? <Alert>{start.error.message}</Alert> : null}
    </div>
  );
}
