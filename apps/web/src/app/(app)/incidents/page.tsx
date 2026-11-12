"use client";

import { Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { allowed } from "@/lib/org-action";
import { useOrg } from "@/lib/session";
import { IncidentTable } from "@/components/incident-table";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { useIncidents } from "@/lib/incidents";

export default function IncidentsPage() {
  const incidents = useIncidents();
  const org = useOrg();
  return (
    <>
      <PageHeader
        title="Incidents"
        description="Each incident is one problem that may owe customers money."
        actions={
          allowed(org?.permissions, "incident.write") ? (
            <Button asChild>
              <Link href="/incidents/new">
                <Plus /> Open an incident
              </Link>
            </Button>
          ) : null
        }
      />
      {incidents.isPending ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : incidents.isError ? (
        <Alert>{incidents.error.message}</Alert>
      ) : incidents.data.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No incidents yet</CardTitle>
            <CardDescription>Open one when a supplier tells you about a faulty batch, or try the demo from the home page.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <IncidentTable rows={incidents.data} />
      )}
    </>
  );
}
