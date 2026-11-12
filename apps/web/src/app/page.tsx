import { CheckCircle2, FileSearch, ListChecks, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { DemoButton } from "@/components/demo-button";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

const STEPS = [
  {
    icon: FileSearch,
    title: "Read the supplier's notice",
    text: "The recall notice becomes rules a person checks: which products, which batches, which dates. Every rule quotes the notice.",
  },
  {
    icon: ListChecks,
    title: "Find who received the batch",
    text: "For every buyer, two separate answers: is this their PayPal payment, and was their unit affected? Unclear records are held, not paid.",
  },
  {
    icon: ShieldCheck,
    title: "Approve one exact list",
    text: "An approval covers one versioned payment list. If a customer, rule or balance changes, the approval is withdrawn.",
  },
  {
    icon: CheckCircle2,
    title: "Refund through PayPal, once",
    text: "Each refund carries a fixed request ID, so a lost reply is asked again, never paid twice. Only PayPal-confirmed payments show as paid.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-2">
          <Button variant="ghost" asChild>
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/sign-up">Create account</Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
        <section className="grid gap-10 py-14 lg:grid-cols-[1.2fr_1fr] lg:items-center lg:py-24">
          <div className="flex flex-col gap-6">
            <p className="text-sm font-medium uppercase tracking-wider text-primary">Product recalls, refunded through PayPal</p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Who is owed money, why, how much, and what was actually paid.</h1>
            <p className="max-w-xl text-lg text-muted-foreground text-pretty">
              When a supplier recalls one batch, refunding is the easy part. Working out which customers received that batch, from records that never quite
              agree, is the hard part. Make Good does that part in the open.
            </p>
            <div className="flex flex-wrap items-start gap-3">
              <DemoButton />
              <Button size="lg" variant="outline" asChild>
                <Link href="/sign-up">Start with your own shop</Link>
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              The demo loads 32 invented orders on a built-in PayPal simulator. No real money and no real customers.
            </p>
          </div>
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <p className="text-sm font-medium text-muted-foreground">Recall: batch B-2217, HM-300 hand mixer</p>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              {[
                ["Affected units", "23"],
                ["Proven from records", "20"],
                ["Held for a person", "5"],
                ["Paid twice", "0"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-muted p-4">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">Figures from the demo case, measured against answers fixed in advance.</p>
          </div>
        </section>

        <section className="grid gap-4 pb-20 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <div key={title} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-2 text-primary">
                <Icon className="size-5" aria-hidden />
                <span className="text-xs font-semibold">Step {i + 1}</span>
              </div>
              <h2 className="mt-3 font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <span>Make Good. PayPal sandbox and simulator only; live payments are switched off.</span>
          <span>AI proposes, people decide.</span>
        </div>
      </footer>
    </div>
  );
}
