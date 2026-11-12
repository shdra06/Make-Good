"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { use, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";

export default function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [mismatch, setMismatch] = useState(false);
  const reset = useMutation({ mutationFn: (password: string) => api.post("/api/auth/password-reset/confirm", { token, password }) });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    const same = password === String(f.get("again"));
    setMismatch(!same);
    if (same) reset.mutate(password);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>Every device signed in to your account will be signed out.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {reset.isSuccess ? (
          <>
            <Alert tone="info" data-testid="reset-done">
              Your password is changed. Sign in with the new one.
            </Alert>
            <Button asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={200}
              required
              hint="At least 10 characters."
            />
            <Field label="The same again" name="again" type="password" autoComplete="new-password" required />
            {mismatch ? <Alert>The two passwords are not the same.</Alert> : null}
            {reset.error ? (
              <Alert>
                {reset.error.message}{" "}
                <Link href="/forgot-password" className="underline">
                  Ask for a new link
                </Link>
              </Alert>
            ) : null}
            <Button type="submit" disabled={reset.isPending}>
              {reset.isPending ? <Loader2 className="animate-spin" /> : null}
              Set the new password
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
