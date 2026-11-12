"use client";

import { animate, motion, MotionConfig, useInView, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { BadgeCheck, Bot, CheckCircle2, FileSearch, Fingerprint, Hand, ListChecks, Repeat2, ScrollText, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Every animation on the page respects the visitor's "reduce motion" setting. */
export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay, ease: [0.21, 0.6, 0.35, 1] }}
    >
      {children}
    </motion.div>
  );
}

function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(to);
      return;
    }
    const controls = animate(0, to, { duration: 1.4, ease: "easeOut", onUpdate: (v) => setValue(Math.round(v)) });
    return () => controls.stop();
  }, [inView, reduce, to]);
  return (
    <span ref={ref} className="tabular-nums">
      {value}
    </span>
  );
}

const STATS = [
  { value: 23, label: "affected orders found", tone: "text-hold" },
  { value: 20, label: "proven from the shop's records", tone: "text-ok" },
  { value: 5, label: "held for a person", tone: "text-hold" },
  { value: 0, label: "customers paid twice", tone: "text-foreground" },
];

export function Stats() {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border lg:grid-cols-4">
      {STATS.map((s) => (
        <div key={s.label} className="bg-card px-6 py-6">
          <p className={cn("text-4xl font-semibold tracking-tight", s.tone)}>
            <CountUp to={s.value} />
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{s.label}</p>
        </div>
      ))}
    </div>
  );
}

// ---------- tilted screens ----------

function Tilt({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rx = useSpring(useTransform(y, [-0.5, 0.5], [7, -7]), { stiffness: 150, damping: 18 });
  const ry = useSpring(useTransform(x, [-0.5, 0.5], [-9, 9]), { stiffness: 150, damping: 18 });
  return (
    <div className={cn("[perspective:1400px]", className)}>
      <motion.div
        style={reduce ? undefined : { rotateX: rx, rotateY: ry, transformStyle: "preserve-3d" }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          x.set((e.clientX - r.left) / r.width - 0.5);
          y.set((e.clientY - r.top) / r.height - 0.5);
        }}
        onPointerLeave={() => {
          x.set(0);
          y.set(0);
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}

function Window({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/15">
      <div className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-2">
        <span className="size-2.5 rounded-full bg-destructive/60" />
        <span className="size-2.5 rounded-full bg-hold/60" />
        <span className="size-2.5 rounded-full bg-ok/60" />
        <span className="ml-2 truncate text-[11px] text-muted-foreground">{title}</span>
      </div>
      <div className="p-4 text-xs">{children}</div>
    </div>
  );
}

const Pill = ({ tone, children }: { tone: "ok" | "hold" | "info"; children: ReactNode }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
      tone === "ok" && "bg-ok/15 text-ok",
      tone === "hold" && "bg-hold/15 text-hold",
      tone === "info" && "bg-info/15 text-info",
    )}
  >
    {children}
  </span>
);

const MATCHES: [string, string, string, "ok" | "hold" | "info"][] = [
  ["Maya Chen", "CM-412 · K-0719", "Payment and unit match", "ok"],
  ["Omar Haddad", "CM-412 · K-0719", "Payment and unit match", "ok"],
  ["J. Okafor", "CM-412 · ?", "Batch not on the packing slip", "hold"],
  ["Lucía Ramos", "CM-412 · K-0719", "Payment and unit match", "ok"],
  ["Dev Patel", "CM-412 · K-0719", "Paid by a different email", "hold"],
  ["Ana Silva", "CM-412 · K-0719", "Payment and unit match", "ok"],
  ["Tom Becker", "CM-412 · K-0733", "Different batch", "info"],
];

function MatchScreen() {
  return (
    <Window title="Customers · CM-412 recall">
      <p className="mb-3 font-medium">Who received batch K-0719?</p>
      <div className="flex flex-col divide-y rounded-lg border">
        {MATCHES.map(([name, item, why, tone]) => (
          <div key={name} className="flex items-center gap-3 px-3 py-2">
            <span className="w-24 truncate font-medium">{name}</span>
            <span className="hidden w-28 truncate text-muted-foreground sm:block">{item}</span>
            <span className="flex-1 truncate text-muted-foreground">{why}</span>
            <Pill tone={tone}>{tone === "ok" ? "Proven" : tone === "hold" ? "Held" : "Not affected"}</Pill>
          </div>
        ))}
      </div>
    </Window>
  );
}

function ApprovalScreen() {
  return (
    <Window title="Approval · list v3">
      <p className="font-medium">Refund list, version 3</p>
      <p className="mt-1 text-muted-foreground">20 customers · fingerprint 9f2c…a41e</p>
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span>Built by Sam (operator)</span>
          <Pill tone="info">Cannot approve</Pill>
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span>Approved by Priya (finance)</span>
          <Pill tone="ok">1 of 1</Pill>
        </div>
      </div>
    </Window>
  );
}

function PaymentsScreen() {
  return (
    <Window title="Payments · PayPal sandbox">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">Refunds</p>
        <span className="text-muted-foreground">18 confirmed · 2 waiting</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full w-[90%] rounded-full bg-ok" />
      </div>
      <div className="mt-3 flex flex-col gap-1.5 font-mono text-[10px] text-muted-foreground">
        <span>refund 8XK2… · reply lost · asked again, same request ID</span>
        <span className="text-ok">PayPal: COMPLETED · one refund, not two</span>
      </div>
    </Window>
  );
}

export function Screens() {
  return (
    <div className="relative grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-center">
      <p className="sr-only">Simplified drawings of three screens of the app. The names are invented.</p>
      <Reveal>
        <Tilt>
          <MatchScreen />
        </Tilt>
      </Reveal>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_60%_at_50%_50%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)]"
      />
      <div className="relative z-10 flex flex-col gap-6 lg:-ml-12">
        <Reveal delay={0.1}>
          <Tilt>
            <ApprovalScreen />
          </Tilt>
        </Reveal>
        <Reveal delay={0.2}>
          <Tilt>
            <PaymentsScreen />
          </Tilt>
        </Reveal>
      </div>
    </div>
  );
}

// ---------- the four steps, drawn as you scroll ----------

const STEPS = [
  {
    icon: FileSearch,
    title: "Read the supplier's notice",
    text: "The recall notice becomes rules a person checks: which products, which batches, which dates. Each rule quotes the line it came from.",
    detail: "“Affected production batch: K-0719 only.”",
  },
  {
    icon: ListChecks,
    title: "Find who received the batch",
    text: "Two separate questions for every buyer: is this their PayPal payment, and was their unit in the batch? Unclear records are held, never guessed.",
    detail: "20 proven · 5 held · 7 not affected",
  },
  {
    icon: ShieldCheck,
    title: "Approve one exact list",
    text: "An approval covers one versioned list. Change a customer, a rule or a balance and the approval is withdrawn automatically.",
    detail: "Four-eyes: the builder cannot approve",
  },
  {
    icon: CheckCircle2,
    title: "Refund through PayPal, once",
    text: "Each refund carries a fixed request ID. A lost reply is asked again, never paid twice. Only PayPal-confirmed payments count as paid.",
    detail: "Paid twice: 0",
  },
];

export function Story() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 75%", "end 60%"] });
  const line = useSpring(scrollYProgress, { stiffness: 120, damping: 24 });
  return (
    <div ref={ref} className="relative mx-auto max-w-3xl">
      <div className="absolute top-2 bottom-2 left-5 w-px bg-border" aria-hidden />
      <motion.div className="absolute top-2 bottom-2 left-5 w-px origin-top bg-primary" style={{ scaleY: line }} aria-hidden />
      <ol className="flex flex-col gap-10">
        {STEPS.map(({ icon: Icon, title, text, detail }, i) => (
          <li key={title} className="relative pl-16">
            <motion.span
              className="absolute top-0 left-0 grid size-10 place-items-center rounded-full border bg-card text-primary shadow-sm"
              initial={{ scale: 0.6, opacity: 0 }}
              whileInView={{ scale: 1, opacity: 1 }}
              viewport={{ once: true, margin: "-120px" }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
            >
              <Icon className="size-5" aria-hidden />
            </motion.span>
            <Reveal>
              <p className="text-xs font-semibold tracking-wider text-primary uppercase">Step {i + 1}</p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-muted-foreground">{text}</p>
              <p className="mt-3 inline-block rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">{detail}</p>
            </Reveal>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- strengths ----------

function Card({
  className,
  icon: Icon,
  title,
  children,
  visual,
}: {
  className?: string;
  icon: typeof Bot;
  title: string;
  children: ReactNode;
  visual?: ReactNode;
}) {
  return (
    <motion.div
      className={cn("group relative flex flex-col overflow-hidden rounded-2xl border bg-card p-6", className)}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      whileHover={{ y: -4 }}
      transition={{ duration: 0.4 }}
    >
      <div className="pointer-events-none absolute -top-24 -right-24 size-48 rounded-full bg-primary/10 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100" />
      <Icon className="size-5 text-primary" aria-hidden />
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
      {visual ? <div className="mt-5 flex-1">{visual}</div> : null}
    </motion.div>
  );
}

export function Bento() {
  return (
    <div className="grid gap-4 md:grid-cols-6">
      <Card
        className="md:col-span-4"
        icon={Repeat2}
        title="A lost reply never pays twice"
        visual={
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="rounded-md border px-2 py-1">POST /refund · id r-7f3a</span>
            <span className="text-destructive">reply lost</span>
            <span className="rounded-md border px-2 py-1">POST /refund · id r-7f3a</span>
            <span className="rounded-md bg-ok/15 px-2 py-1 text-ok">one refund</span>
          </div>
        }
      >
        Every refund has a request ID fixed before it is sent. If PayPal&apos;s answer is lost, Make Good asks again with the same ID, and PayPal returns the
        first refund instead of making a second.
      </Card>
      <Card className="md:col-span-2" icon={UsersRound} title="Four-eyes approval">
        The person who builds a payment list cannot approve it. Large lists can need more approvers.
      </Card>
      <Card className="md:col-span-2" icon={Bot} title="AI proposes, people decide">
        Gemini reads the notice and suggests rules and product aliases, each quoting its source. Nothing is used until a person accepts it.
      </Card>
      <Card className="md:col-span-2" icon={Hand} title="Held, not guessed">
        When the payment or the batch is unclear, the record waits for a person, or for the customer&apos;s own answer through a one-time link.
      </Card>
      <Card className="md:col-span-2" icon={ScrollText} title="A full record">
        Every rule, decision, approval and PayPal reply is on the audit trail, with who did it and when.
      </Card>
      <Card
        className="md:col-span-3"
        icon={Fingerprint}
        title="Approval of one exact list"
        visual={<p className="font-mono text-[11px] text-muted-foreground">v3 · 20 customers · sha256 9f2c…a41e</p>}
      >
        An approval is tied to the list&apos;s fingerprint. Any change makes a new version that needs approving again.
      </Card>
      <Card
        className="md:col-span-3"
        icon={BadgeCheck}
        title="Paid means PayPal said so"
        visual={
          <div className="flex gap-2">
            <Pill tone="info">Sent</Pill>
            <Pill tone="hold">Waiting for PayPal</Pill>
            <Pill tone="ok">Confirmed by PayPal</Pill>
          </div>
        }
      >
        A customer shows as paid only after PayPal confirms the refund, never because a button was pressed.
      </Card>
    </div>
  );
}
