"use client";

import { Loader2 } from "lucide-react";
import { IncidentTable } from "@/components/incident-table";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { useIncidents } from "@/lib/incidents";

export default function IncidentsPage() {
  const incidents = useIncidents();
  return (
    <>
      <PageHeader title="Incidents" description="Each incident is one problem that may owe customers money." />
      {incidents.isPending ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : incidents.isError ? (
        <Alert>{incidents.error.message}</Alert>
      ) : incidents.data.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No incidents yet</CardTitle>
            <CardDescription>Opening an incident from a supplier&apos;s notice comes in the next part of the rebuild.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <IncidentTable rows={incidents.data} />
      )}
    </>
  );
}
