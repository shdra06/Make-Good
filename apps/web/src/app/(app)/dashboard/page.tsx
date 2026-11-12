"use client";

import Link from "next/link";
import { IncidentTable } from "@/components/incident-table";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { useIncidents } from "@/lib/incidents";
import { CreateWorkspace } from "@/components/create-workspace";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { useMe, useOrg } from "@/lib/session";

export default function DashboardPage() {
  const me = useMe();
  const org = useOrg();
  const incidents = useIncidents();
  const rows = incidents.data ?? [];
  const totals = rows.reduce(
    (t, r) => ({ open: t.open + (r.status === "active" || r.status === "draft" ? 1 : 0), awaiting: t.awaiting + r.awaiting, paid: t.paid + r.paid }),
    { open: 0, awaiting: 0, paid: 0 },
  );

  if (me.data && !org) {
    return (
      <>
        <PageHeader title={`Hello, ${me.data.user.name.split(" ")[0] ?? ""}`} description="One step before the dashboard." />
        <CreateWorkspace />
      </>
    );
  }

  return (
    <>
      <PageHeader title={`Hello, ${me.data?.user.name.split(" ")[0] ?? ""}`} description="What needs a person, and what PayPal has confirmed." />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        {[
          ["Open incidents", totals.open],
          ["Customers waiting for a decision", totals.awaiting],
          ["Payments confirmed by PayPal", totals.paid],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{incidents.isPending ? <Skeleton className="h-9 w-14" /> : value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <h2 className="mb-3 text-lg font-semibold">Recent incidents</h2>
      {incidents.isPending ? (
        <TableSkeleton />
      ) : incidents.isError ? (
        <Alert>{incidents.error.message}</Alert>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No incidents yet</CardTitle>
            <CardDescription>An incident is one problem that may owe customers money, such as a supplier recalling a batch.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/incidents">Go to incidents</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <IncidentTable rows={rows.slice(0, 5)} />
      )}
    </>
  );
}
