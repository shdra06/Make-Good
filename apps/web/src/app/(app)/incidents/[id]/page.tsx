"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { nextStep, useIncident } from "@/lib/incident-context";

/** Opening an incident goes to the step that needs doing next. */
export default function IncidentIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { progress, batch, detail, notices } = useIncident();
  const router = useRouter();
  const ready = !detail.isPending && !batch.isLoading && !notices.isPending;
  const tab = nextStep(progress, batch.data?.batch.status)?.tab ?? "payments";
  useEffect(() => {
    if (ready) router.replace(`/incidents/${id}/${tab}`);
  }, [id, ready, router, tab]);
  return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />;
}
