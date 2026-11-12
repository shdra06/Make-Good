"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { KIND_LABELS, STATUS_TONE } from "@/lib/incidents";
import { orgPath, useOrg } from "@/lib/session";

type IncidentDetail = { incident: { id: string; kind: string; title: string; description: string; status: string } };

export default function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const org = useOrg();
  const detail = useQuery({
    queryKey: ["incident", org?.orgId, id],
    queryFn: () => api.get<IncidentDetail>(orgPath(org!, `/incidents/${id}`)),
    enabled: org !== null,
  });

  return (
    <>
      <Link href="/incidents" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Incidents
      </Link>
      {detail.isPending ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : detail.isError ? (
        <Alert>{detail.error.message}</Alert>
      ) : (
        <>
          <PageHeader
            title={detail.data.incident.title}
            description={KIND_LABELS[detail.data.incident.kind] ?? detail.data.incident.kind}
            actions={
              <Badge tone={STATUS_TONE[detail.data.incident.status] ?? "neutral"} className="capitalize">
                {detail.data.incident.status}
              </Badge>
            }
          />
          <Card>
            <CardHeader>
              <CardTitle>The recall workflow is being moved here</CardTitle>
              <CardDescription>
                Reading the notice, the two-question table, the Recovery Map, options, the payment list and payments arrive in the next part of the rebuild, as
                tabs on this page.
              </CardDescription>
            </CardHeader>
          </Card>
        </>
      )}
    </>
  );
}
