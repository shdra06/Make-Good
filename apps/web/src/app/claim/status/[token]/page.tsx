"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, use, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Label } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { time, words } from "@/lib/format";
import { ACCEPT, uploadFiles } from "../../files";

type Status = {
  ref: string;
  status: string;
  shop: string;
  title: string;
  submittedAt: string;
  canAddFiles: boolean;
  events: { kind: string; body: string | null; created_at: string }[];
  files: { kind: string; original_name: string | null; uploaded_at: string }[];
};

const SAY: Record<string, string> = {
  submitted: "Received. The shop has not looked at it yet.",
  under_review: "The shop is looking at it.",
  needs_evidence: "The shop needs more evidence. Add a photo below.",
  approved: "Accepted.",
  rejected: "Not accepted.",
  paid: "Paid.",
  withdrawn: "Withdrawn.",
};

function StatusView({ token }: { token: string }) {
  const fileError = useSearchParams().get("fileError");
  const input = useRef<HTMLInputElement>(null);
  const status = useQuery({ queryKey: ["claim-status", token], queryFn: () => api.get<Status>(`/api/public/claims/status/${token}`), retry: false });
  const add = useMutation({
    mutationFn: async () => uploadFiles(token, Array.from(input.current?.files ?? []), "receipt"),
    onSuccess: () => {
      if (input.current) input.current.value = "";
      void status.refetch();
    },
  });
  const s = status.data;

  return (
    <Card className="w-full max-w-lg">
      {status.isPending ? (
        <CardContent className="grid place-items-center py-10">
          <Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" />
        </CardContent>
      ) : status.isError ? (
        <CardContent className="py-6">
          <Alert>This link does not work. Use the link in the email the shop sent you.</Alert>
        </CardContent>
      ) : (
        <>
          <CardHeader>
            <CardDescription>
              {s!.shop} · claim {s!.ref}
            </CardDescription>
            <CardTitle className="text-xl">{s!.title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm">
            <div className="flex items-center gap-2" data-testid="claim-status">
              <Badge tone={s!.status === "approved" ? "ok" : s!.status === "rejected" ? "stop" : s!.status === "needs_evidence" ? "hold" : "info"}>
                {words(s!.status)}
              </Badge>
              <span>{SAY[s!.status] ?? ""}</span>
            </div>
            {fileError ? <Alert tone="hold">Your claim was sent, but a file was not: {fileError}</Alert> : null}
            <div>
              <p className="mb-2 font-medium">Messages</p>
              <ul className="flex flex-col gap-2">
                {s!.events.map((e, i) => (
                  <li key={i} className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">{time(e.created_at)}</p>
                    <p>{e.body ?? words(e.kind)}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 font-medium">Files you sent ({s!.files.length})</p>
              {s!.files.length === 0 ? (
                <p className="text-muted-foreground">None yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {s!.files.map((f, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <CheckCircle2 className="size-4 text-ok" /> {f.original_name ?? words(f.kind)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {s!.canAddFiles ? (
              <div className="flex flex-col gap-2 rounded-lg border p-3">
                <Label htmlFor="more">Add a photo or PDF</Label>
                <input ref={input} id="more" type="file" accept={ACCEPT} multiple className="text-sm" />
                {add.error ? <Alert>{add.error.message}</Alert> : null}
                <Button size="sm" className="w-fit" disabled={add.isPending} onClick={() => add.mutate()}>
                  {add.isPending ? <Loader2 className="animate-spin" /> : null}
                  Send the files
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">Keep this page&apos;s link private: anyone with it can see this claim.</p>
          </CardContent>
        </>
      )}
    </Card>
  );
}

export default function ClaimStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return (
    <div className="flex min-h-dvh justify-center px-4 py-10">
      <Suspense>
        <StatusView token={token} />
      </Suspense>
    </div>
  );
}
