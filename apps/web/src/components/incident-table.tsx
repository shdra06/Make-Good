"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/primitives";
import { dateLabel, KIND_LABELS, STATUS_TONE, type IncidentRow } from "@/lib/incidents";

export function IncidentTable({ rows }: { rows: IncidentRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Incident</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 text-right font-medium">Waiting for a decision</th>
            <th className="px-4 py-3 text-right font-medium">Confirmed</th>
            <th className="px-4 py-3 text-right font-medium">Paid</th>
            <th className="px-4 py-3 font-medium">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
              <td className="px-4 py-3">
                <Link href={`/incidents/${r.id}`} className="font-medium hover:underline">
                  {r.title}
                </Link>
                <p className="text-xs text-muted-foreground">{KIND_LABELS[r.kind] ?? r.kind}</p>
              </td>
              <td className="px-4 py-3">
                <Badge tone={STATUS_TONE[r.status] ?? "neutral"} className="capitalize">
                  {r.status}
                </Badge>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{r.awaiting}</td>
              <td className="px-4 py-3 text-right tabular-nums">{r.confirmed}</td>
              <td className="px-4 py-3 text-right tabular-nums">{r.paid}</td>
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{dateLabel(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
