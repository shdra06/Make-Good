// Small building blocks in the shadcn/ui style: Card, Input, Label, Badge,
// Alert. Each is a styled HTML element; they take every normal prop.

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-xl border bg-card text-card-foreground shadow-sm", className)} {...props} />;
}
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 p-6 pb-3", className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold leading-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-6 pt-3", className)} {...props} />;
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs placeholder:text-muted-foreground disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium leading-none", className)} {...props} />;
}

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground border-transparent",
      ok: "bg-ok/10 text-ok border-ok/25",
      hold: "bg-hold/10 text-hold border-hold/30",
      stop: "bg-destructive/10 text-destructive border-destructive/25",
      info: "bg-info/10 text-info border-info/25",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Alert({ className, tone = "stop", ...props }: ComponentProps<"div"> & { tone?: "stop" | "info" | "hold" }) {
  const tones = {
    stop: "border-destructive/30 bg-destructive/5 text-destructive",
    info: "border-info/30 bg-info/5 text-info",
    hold: "border-hold/30 bg-hold/5 text-hold",
  };
  return <div role="alert" className={cn("rounded-md border px-3 py-2 text-sm", tones[tone], className)} {...props} />;
}
