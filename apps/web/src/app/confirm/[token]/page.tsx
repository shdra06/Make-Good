"use client";

// What a customer sees through the one-time link: one question, nothing else.
// No sign-in, no amounts, no other customer's data.

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { use, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent } from "@/components/ui/primitives";
import { api } from "@/lib/api";

type Question = { merchant: string; incident: string; orderNumber: string | null; product: string | null };

export default function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [code, setCode] = useState("");
  const question = useQuery({
    queryKey: ["confirm", token],
    queryFn: () => api.get<Question>(`/api/public/confirm/${encodeURIComponent(token)}`),
    retry: false,
  });
  const send = useMutation({ mutationFn: () => api.post(`/api/public/confirm/${encodeURIComponent(token)}`, { batchCode: code }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  const q = question.data;

  return (
    <div className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 p-8">
          <p className="text-sm font-medium text-muted-foreground">{q?.merchant ?? "Make Good"}</p>
          {question.isPending ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
          ) : question.isError ? (
            <>
              <h1 className="text-2xl font-semibold">This link cannot be used</h1>
              <p className="text-muted-foreground">This link has already been used, or is not valid.</p>
            </>
          ) : send.isSuccess ? (
            <>
              <ShieldCheck className="size-10 text-ok" aria-hidden />
              <h1 className="text-2xl font-semibold">Thank you</h1>
              <p className="text-muted-foreground">
                {q!.merchant} has your answer. A member of their staff will check it and contact you about what happens next. You do not need to do anything
                else.
              </p>
            </>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <h1 className="text-2xl font-semibold">One question about your order</h1>
              <p className="text-muted-foreground">
                {q!.merchant} is checking orders because of this: {q!.incident}.
              </p>
              <div className="rounded-lg bg-muted p-4">
                <p className="text-xs text-muted-foreground">Order {q!.orderNumber ?? ""}</p>
                <p className="font-semibold">{q!.product ?? "a product"}</p>
              </div>
              <p className="text-sm">Please find the batch code printed on the product or its box, and type it here exactly as printed.</p>
              <Field
                label="Batch code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                placeholder="For example B-1234"
                required
                maxLength={60}
              />
              {send.error ? <Alert>{send.error.message}</Alert> : null}
              <Button type="submit" disabled={send.isPending}>
                {send.isPending ? <Loader2 className="animate-spin" /> : null}
                Send
              </Button>
              <p className="text-xs text-muted-foreground">We ask only for the code. We will never ask for a password or payment details through this page.</p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
