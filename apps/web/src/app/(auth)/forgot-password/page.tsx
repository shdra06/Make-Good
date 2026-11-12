"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import type { FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const ask = useMutation({ mutationFn: (email: string) => api.post("/api/auth/password-reset", { email }) });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    ask.mutate(String(new FormData(e.currentTarget).get("email")));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Reset your password</CardTitle>
        <CardDescription>We will email you a link to choose a new one.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {ask.isSuccess ? (
          <Alert tone="info" data-testid="reset-sent">
            If an account uses that email, a link is on its way. It works once and expires in one hour.
          </Alert>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Email" name="email" type="email" autoComplete="username" required />
            {ask.error ? <Alert>{ask.error.message}</Alert> : null}
            <Button type="submit" disabled={ask.isPending}>
              {ask.isPending ? <Loader2 className="animate-spin" /> : null}
              Email me a link
            </Button>
          </form>
        )}
        <Link href="/sign-in" className="text-center text-sm text-primary hover:underline">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}
