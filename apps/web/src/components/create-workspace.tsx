"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api } from "@/lib/api";

/** For an account that belongs to no workspace yet: make one. */
export function CreateWorkspace() {
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: (name: string) => api.post("/api/orgs", { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["me"] }),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    create.mutate(String(new FormData(e.currentTarget).get("name")).trim());
  };
  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>Create your workspace</CardTitle>
        <CardDescription>You do not belong to a shop yet. Make one, or ask an owner to add you to theirs.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Shop name" name="name" required minLength={2} maxLength={120} />
          {create.error ? <Alert>{create.error.message}</Alert> : null}
          <Button type="submit" className="w-fit" disabled={create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : null}
            Create the workspace
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
