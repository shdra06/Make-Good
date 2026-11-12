"use client";

import { Panel, StepIntro, Tag } from "@/components/incident/bits";
import { Table } from "@/components/ui/form";
import { day, time, words } from "@/lib/format";
import { useIncident } from "@/lib/incident-context";

export default function ActivityStep() {
  const { audit } = useIncident();
  const a = audit.data;
  return (
    <>
      <StepIntro
        question="Audit trail"
        title="Every decision and every change"
        hint="With who made it. Entries cannot be edited or deleted, and each one carries a hash of the one before."
      />
      {!a ? (
        <p className="text-sm text-muted-foreground">The audit trail is not available to your role.</p>
      ) : (
        <Panel
          title="Latest entries"
          actions={<Tag tone={a.chain.ok ? "ok" : "stop"}>{a.chain.ok ? `${a.chain.rows} entries, chain intact` : "the chain is broken"}</Tag>}
        >
          <div data-testid="audit">
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r, i) => (
                  <tr key={r.id ?? i}>
                    <td className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {day(r.created_at)} {time(r.created_at)}
                    </td>
                    <td>{r.actor_name ?? (r.actor_kind === "ai" ? "AI model" : r.actor_kind)}</td>
                    <td>{words(r.action)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Panel>
      )}
    </>
  );
}
