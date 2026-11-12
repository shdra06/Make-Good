"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          Nothing was paid or changed by this error. Try again; if it keeps happening, tell us the reference below.
        </p>
        {error.digest ? <code className="rounded bg-muted px-2 py-1 text-xs">{error.digest}</code> : null}
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
