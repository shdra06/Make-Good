"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { ACCEPT, uploadFiles } from "../files";

type Form = { shop: string; title: string; instructions: string | null; maxFiles: number };

export default function ClaimFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const form = useQuery({ queryKey: ["claim-form", slug], queryFn: () => api.get<Form>(`/api/public/claims/form/${slug}`), retry: false });
  const send = useMutation({
    mutationFn: async (f: FormData) => {
      const files = (f.getAll("files") as File[]).filter((x) => x.size > 0).slice(0, form.data!.maxFiles);
      const { token } = await api.post<{ token: string }>(`/api/public/claims/form/${slug}`, {
        name: f.get("name"),
        email: f.get("email"),
        orderNumber: f.get("orderNumber"),
        batchCode: f.get("batchCode"),
        statement: f.get("statement"),
      });
      // The claim exists now. A refused photo is reported on the status page, where it can be sent again.
      let fileError: string | null = null;
      await uploadFiles(token, files, "product_label").catch((e: Error) => (fileError = e.message));
      return { token, fileError };
    },
    onSuccess: ({ token, fileError }) => router.push(`/claim/status/${token}${fileError ? `?fileError=${encodeURIComponent(fileError)}` : ""}`),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    send.mutate(new FormData(e.currentTarget));
  };

  return (
    <div className="flex min-h-dvh justify-center px-4 py-10">
      <Card className="w-full max-w-lg">
        {form.isPending ? (
          <CardContent className="grid place-items-center py-10">
            <Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" />
          </CardContent>
        ) : form.isError ? (
          <CardContent className="py-6">
            <Alert>This claim form is closed or does not exist. Contact the shop you bought from.</Alert>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <CardDescription>{form.data.shop}</CardDescription>
              <CardTitle className="text-xl">{form.data.title}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {form.data.instructions ?? "If you bought an affected product, tell the shop here. They will check it against their records and contact you."}
              </p>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Field label="Your name" name="name" autoComplete="name" required maxLength={120} />
                <Field
                  label="Your email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  hint="Where the shop will reply. Use the one you ordered with, if you can."
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Order number" name="orderNumber" maxLength={60} hint="From your order email, if you have it." />
                  <Field label="Batch code" name="batchCode" maxLength={60} hint="Printed on the product or its box." />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="statement">What happened</Label>
                  <Textarea
                    id="statement"
                    name="statement"
                    rows={4}
                    required
                    minLength={10}
                    maxLength={4000}
                    placeholder="What you bought, roughly when, and where."
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="files">Photos of the receipt or label (optional)</Label>
                  <input id="files" name="files" type="file" accept={ACCEPT} multiple className="text-sm" />
                  <p className="text-xs text-muted-foreground">Up to {form.data.maxFiles} photos or PDFs, 4 MB each.</p>
                </div>
                {send.error ? <Alert>{send.error.message}</Alert> : null}
                <Button type="submit" disabled={send.isPending}>
                  {send.isPending ? <Loader2 className="animate-spin" /> : null}
                  Send the claim
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  The shop receives what you send here. Read how it is kept in the{" "}
                  <Link href="/privacy" className="underline">
                    privacy notice
                  </Link>
                  .
                </p>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
