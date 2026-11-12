"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";

function SignInForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const client = useQueryClient();
  const signIn = useMutation({
    mutationFn: (body: { email: string; password: string }) => api.post("/api/auth/login", body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["me"] });
      // Only same-site paths: never send someone to another site after sign-in.
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    signIn.mutate({ email: String(form.get("email")), password: String(form.get("password")) });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign in</CardTitle>
        <CardDescription>Welcome back.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email" name="email" type="email" autoComplete="username" required />
          <Field label="Password" name="password" type="password" autoComplete="current-password" required />
          <Link href="/forgot-password" className="-mt-2 w-fit text-sm text-primary hover:underline">
            Forgot your password?
          </Link>
          {signIn.error ? <Alert>{signIn.error.message}</Alert> : null}
          <Button type="submit" disabled={signIn.isPending}>
            {signIn.isPending ? <Loader2 className="animate-spin" /> : null}
            Sign in
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link href="/sign-up" className="font-medium text-primary hover:underline">
              Create an account
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
