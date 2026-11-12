import { Table } from "@/components/ui/form";
import { money } from "@/lib/format";
import { HELD_WHY } from "@/lib/labels";
import type { HeldItem } from "@/lib/types";

export function HeldTable({ held }: { held: HeldItem[] | null | undefined }) {
  if (!held || held.length === 0) return <p className="text-sm text-muted-foreground">Nobody is left off.</p>;
  return (
    <div className="max-h-64 overflow-y-auto">
      <Table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Why it is left off</th>
            <th className="text-right">Would be</th>
          </tr>
        </thead>
        <tbody>
          {held.map((x, i) => (
            <tr key={`${x.orderNumber}-${i}`}>
              <td className="font-mono">{x.orderNumber ?? "no order"}</td>
              <td>{x.customerName ?? x.customerEmail ?? "–"}</td>
              <td>{HELD_WHY[x.why] ?? x.why}</td>
              <td className="text-right tabular-nums">{x.wouldPayMinor ? money(x.wouldPayMinor, x.currency ?? "USD") : "–"}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
