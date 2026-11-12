"use client";

import { ROLE_LABELS, ROLES, type Role } from "@makegood/shared";
import { useQuery } from "@tanstack/react-query";
import { Loader2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Panel, Tag } from "@/components/incident/bits";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Select, Table } from "@/components/ui/form";
import { Alert, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { day } from "@/lib/format";
import { allowed, useOrgAction } from "@/lib/org-action";
import { orgPath, useMe, useOrg } from "@/lib/session";

type Member = { user_id: string; email: string; name: string; role: Role; created_at: string };
type Invitation = { id: string; email: string; role: Role; created_at: string; expires_at: string; invited_by: string | null };

/** What each role may do, in words. Mirrors the API's grants; the API is what enforces them. */
const ROLE_DOES: Record<Role, string> = {
  owner: "Everything, including making other owners.",
  admin: "Everything except making owners: team, connections, settings, incidents, payments.",
  finance_approver: "Approves payment lists and starts payments. Reads the audit trail. Cannot change incidents.",
  operator: "Imports orders, opens incidents, decides records, builds payment lists and starts payments. Cannot approve.",
  reviewer: "Decides held customer records. Cannot build, approve or pay.",
  viewer: "Reads everything except the audit trail. Changes nothing.",
};

export default function TeamPage() {
  const org = useOrg();
  const me = useMe();
  const key = ["members", org?.orgId];
  const members = useQuery({ queryKey: key, queryFn: () => api.get<Member[]>(orgPath(org!, "/members")), enabled: org !== null });
  const invitesKey = ["invitations", org?.orgId];
  const canManageTeam = allowed(org?.permissions, "members.manage");
  const invitations = useQuery({
    queryKey: invitesKey,
    queryFn: () => api.get<Invitation[]>(orgPath(org!, "/invitations")),
    enabled: org !== null && canManageTeam,
  });
  const { run, pending } = useOrgAction([key, invitesKey]);
  const [role, setRole] = useState<Role>("operator");
  if (!org) return null;
  const canManage = allowed(org.permissions, "members.manage");
  const isOwner = org.role === "owner";
  const choosable = ROLES.filter((r) => r !== "owner" || isOwner);

  const change = (email: string, next: Role, done: string) => run(() => api.post(orgPath(org, "/members"), { email, role: next }), done);
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email")).trim();
    void run(
      () => api.post<{ sent: boolean }>(orgPath(org, "/invitations"), { email, role }),
      (r) => (r.sent ? `Invitation sent to ${email}.` : `Invitation created for ${email}, but this server cannot send email.`),
    ).then((r) => {
      if (r) form.reset();
    });
  };

  return (
    <>
      <PageHeader title="Team" description="Who can do what. Payments need an approval by a role that may approve; set how many in Settings." />
      <div className="flex flex-col gap-6">
        <Panel title="Members">
          {members.isPending ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
          ) : members.isError ? (
            <Alert>{members.error.message}</Alert>
          ) : (
            <Table data-testid="members">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => {
                  const self = m.user_id === me.data?.user.id;
                  const locked = !canManage || (m.role === "owner" && !isOwner);
                  return (
                    <tr key={m.user_id}>
                      <td className="font-medium">
                        {m.name} {self ? <Tag>you</Tag> : null}
                      </td>
                      <td className="text-muted-foreground">{m.email}</td>
                      <td>
                        {locked ? (
                          ROLE_LABELS[m.role]
                        ) : (
                          <Select
                            aria-label={`Role of ${m.name}`}
                            className="w-48"
                            value={m.role}
                            disabled={pending}
                            onChange={(e) =>
                              void change(m.email, e.target.value as Role, `${m.name} is now ${ROLE_LABELS[e.target.value as Role].toLowerCase()}.`)
                            }
                          >
                            {choosable.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td className="text-muted-foreground">{day(m.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        {canManage ? (
          <Panel title="Invite someone" hint="They get an email with a link. It works once, for 7 days, and only for that address. They join when they accept.">
            <form onSubmit={add} className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Field label="Their email" name="email" type="email" required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-role">Role</Label>
                <Select id="new-role" className="w-48" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {choosable.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" disabled={pending}>
                <UserPlus /> Send invitation
              </Button>
            </form>
            {invitations.data && invitations.data.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-medium">Waiting to be accepted</h3>
                <Table data-testid="invitations">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.data.map((i) => (
                      <tr key={i.id}>
                        <td>{i.email}</td>
                        <td>{ROLE_LABELS[i.role]}</td>
                        <td className="text-muted-foreground">{day(i.expires_at)}</td>
                        <td className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => void run(() => api.delete(orgPath(org, `/invitations/${i.id}`)), `Invitation to ${i.email} withdrawn.`)}
                          >
                            Withdraw
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : null}
          </Panel>
        ) : (
          <Alert tone="info">Only an owner or admin can change the team.</Alert>
        )}

        <Panel title="What each role may do">
          <dl className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((r) => (
              <div key={r} className="rounded-lg border p-3">
                <dt className="font-medium">{ROLE_LABELS[r]}</dt>
                <dd className="text-sm text-muted-foreground">{ROLE_DOES[r]}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
