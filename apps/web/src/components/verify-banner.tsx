"use client";

import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useOrgAction } from "@/lib/org-action";
import { useMe } from "@/lib/session";

/**
 * Shown until the account's email is confirmed. Addresses at example.com cannot
 * receive mail (the demo uses them), so they get no banner.
 */
export function VerifyBanner() {
  const me = useMe();
  const { run, pending } = useOrgAction([["me"]]);
  const user = me.data?.user;
  if (!user || user.emailVerified || /@example\.(com|org|net)$/i.test(user.email)) return null;
  const resend = () =>
    run(
      () => api.post<{ sent: boolean; alreadyVerified: boolean }>("/api/auth/verify-email"),
      (r) => (r.alreadyVerified ? "Your email is already confirmed." : `A new link is on its way to ${user.email}.`),
    );
  return (
    <div data-testid="verify-banner" className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-hold/30 bg-hold/5 px-4 py-3 text-sm">
      <MailCheck className="size-4 shrink-0 text-hold" />
      <span className="flex-1">
        Confirm your email: we sent a link to <strong>{user.email}</strong>. It proves the address is yours, which you need to reset a password.
      </span>
      <Button size="sm" variant="outline" onClick={() => void resend()} disabled={pending}>
        Send a new link
      </Button>
    </div>
  );
}
