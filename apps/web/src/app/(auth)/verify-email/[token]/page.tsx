"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";

/** Asks before confirming, so a mail scanner that opens the link does not use it up. */
export default function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const client = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post<{ email: string }>("/api/auth/verify-email/confirm", { token }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Confirm your email</CardTitle>
        <CardDescription>This tells us the address on your account is really yours.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {verify.isSuccess ? (
          <>
            <Alert tone="info" data-testid="verify-done">
              {verify.data.email} is confirmed.
            </Alert>
            <Button asChild>
              <Link href="/dashboard">Go to the dashboard</Link>
            </Button>
          </>
        ) : (
          <>
            {verify.error ? <Alert>{verify.error.message}</Alert> : null}
            <Button onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? <Loader2 className="animate-spin" /> : null}
              Confirm my email
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
