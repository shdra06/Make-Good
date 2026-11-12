import { useId, type ComponentProps } from "react";
import { Input, Label } from "@/components/ui/primitives";

/** A labelled input with an optional hint. */
export function Field({ label, hint, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-describedby={hintId} {...props} />
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
