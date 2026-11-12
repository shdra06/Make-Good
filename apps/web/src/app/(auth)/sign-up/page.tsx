"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";

type SignUp = { name: string; email: string; password: string; shop: string };

export default function SignUpPage() {
  const router = useRouter();
  const client = useQueryClient();
  const signUp = useMutation({
    mutationFn: async (body: SignUp) => {
      await api.post("/api/auth/register", { name: body.name, email: body.email, password: body.password });
      await api.post("/api/orgs", { name: body.shop });
    },
    onSuccess: async () => {
      // Forget any "signed out" answer from before, so the app asks again instead of sending you back here.
      client.removeQueries({ queryKey: ["me"] });
      router.replace("/dashboard");
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    signUp.mutate({ name: String(f.get("name")), email: String(f.get("email")), password: String(f.get("password")), shop: String(f.get("shop")) });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>You become the owner of your shop&apos;s workspace and can invite your team later.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Your name" name="name" autoComplete="name" required maxLength={120} />
          <Field label="Work email" name="email" type="email" autoComplete="email" required />
          <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters." />
          <Field label="Shop name" name="shop" required minLength={2} maxLength={120} placeholder="Emberline Ceramics" />
          {signUp.error ? <Alert>{signUp.error.message}</Alert> : null}
          <Button type="submit" disabled={signUp.isPending}>
            {signUp.isPending ? <Loader2 className="animate-spin" /> : null}
            Create account
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
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/sign-in" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
