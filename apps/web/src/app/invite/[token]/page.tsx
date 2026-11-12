"use client";

import { ROLE_LABELS, type Role } from "@makegood/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { chooseOrg, useMe, useSignOut } from "@/lib/session";

type Invitation = { organisation: string; role: Role; email: string; accountExists: boolean };

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const client = useQueryClient();
  const me = useMe();
  const signOut = useSignOut();
  const invitation = useQuery({ queryKey: ["invitation", token], queryFn: () => api.get<Invitation>(`/api/public/invitations/${token}`), retry: false });

  const accept = useMutation({
    mutationFn: async (newAccount?: { name: string; password: string }) => {
      if (newAccount) await api.post("/api/auth/register", { email: invitation.data!.email, ...newAccount });
      return api.post<{ orgId: string }>("/api/auth/invitations/accept", { token });
    },
    onSuccess: async ({ orgId }) => {
      chooseOrg(orgId);
      client.removeQueries({ queryKey: ["me"] });
      router.replace("/dashboard");
    },
  });
  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    accept.mutate({ name: String(f.get("name")), password: String(f.get("password")) });
  };

  const user = me.data?.user;
  const inv = invitation.data;
  const sameEmail = user && inv && user.email.toLowerCase() === inv.email;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <Logo />
      <Card className="w-full max-w-sm">
        {invitation.isPending || me.isPending ? (
          <CardContent className="grid place-items-center py-10">
            <Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" />
          </CardContent>
        ) : invitation.isError ? (
          <CardContent className="py-6">
            <Alert>{invitation.error.message}</Alert>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <CardTitle className="text-xl">Join {inv!.organisation}</CardTitle>
              <CardDescription>
                You are invited as <strong>{ROLE_LABELS[inv!.role].toLowerCase()}</strong>. The invitation is for {inv!.email}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {accept.error ? <Alert>{accept.error.message}</Alert> : null}
              {sameEmail ? (
                <Button onClick={() => accept.mutate(undefined)} disabled={accept.isPending}>
                  {accept.isPending ? <Loader2 className="animate-spin" /> : null}
                  Accept and open the workspace
                </Button>
              ) : user ? (
                <>
                  <Alert tone="hold">
                    You are signed in as {user.email}. This invitation is for {inv!.email}; sign in with that address to accept it.
                  </Alert>
                  <Button variant="outline" onClick={() => signOut.mutate()}>
                    Sign out
                  </Button>
                </>
              ) : inv!.accountExists ? (
                <Button asChild>
                  <Link href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
                </Button>
              ) : (
                <form onSubmit={create} className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">Create your account to join.</p>
                  <Field label="Email" value={inv!.email} readOnly />
                  <Field label="Your name" name="name" autoComplete="name" required maxLength={120} />
                  <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters." />
                  <Button type="submit" disabled={accept.isPending}>
                    {accept.isPending ? <Loader2 className="animate-spin" /> : null}
                    Create account and join
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    By creating an account you agree to the{" "}
                    <Link href="/terms" className="underline">
                      terms
                    </Link>{" "}
                    and the{" "}
                    <Link href="/privacy" className="underline">
                      privacy notice
                    </Link>
                    .
                  </p>
                </form>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
