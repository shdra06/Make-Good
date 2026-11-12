"use client";

// A panel that slides in from the right, on Radix Dialog: focus is trapped
// inside, Escape and the backdrop close it, and screen readers get a title.

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-in" />
        <Dialog.Content
          className={cn("fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background shadow-xl outline-none", className)}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="flex items-start gap-3 border-b px-6 py-4">
            <div className="min-w-0 flex-1">
              {description ? <Dialog.Description className="text-xs text-muted-foreground">{description}</Dialog.Description> : null}
              <Dialog.Title className="truncate text-lg font-semibold">{title}</Dialog.Title>
            </div>
            <Dialog.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
