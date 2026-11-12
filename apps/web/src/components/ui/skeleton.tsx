import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A grey shape where content will appear, so the page does not jump when it loads. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

/** Placeholder rows for a table that is loading. */
export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
