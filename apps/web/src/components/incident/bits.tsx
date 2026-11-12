import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card } from "@/components/ui/primitives";
import { KIND, SOURCE, STRENGTH, type Tone } from "@/lib/labels";
import type { EvidenceItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A titled block of a step page. */
export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={cn("p-5", className)} data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{title}</h2>
          {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </Card>
  );
}

export function StepIntro({ question, title, hint }: { question: string; title: string; hint?: string }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{question}</p>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {hint ? <p className="max-w-3xl text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Locked({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
      <Lock className="size-4 shrink-0" aria-hidden /> {children}
    </div>
  );
}

export function Tag({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <Badge tone={tone} title={title}>
      {children}
    </Badge>
  );
}

export function EvidenceLine({ e }: { e: EvidenceItem }) {
  const kind = KIND[e.kind] ?? { label: e.kind, tone: "neutral" as Tone };
  return (
    <div className="flex flex-col gap-1 border-t py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Tag tone={kind.tone}>{kind.label}</Tag>
        <span>
          {SOURCE[e.source] ?? e.source} · {STRENGTH[e.strength] ?? e.strength}
        </span>
      </div>
      <p className="text-sm">{e.fact}</p>
    </div>
  );
}

/** Label on the left, value on the right; stacks on phones. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t py-2 first:border-t-0 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className={cn("text-xl font-semibold tabular-nums", tone)}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
