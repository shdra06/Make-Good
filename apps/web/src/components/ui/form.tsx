import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const control = "w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs disabled:opacity-50";

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(control, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "min-h-20 py-2", className)} {...props} />;
}

/** A plain data table with the app's styling. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          "w-full text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_tbody_tr]:border-t",
          className,
        )}
        {...props}
      />
    </div>
  );
}
