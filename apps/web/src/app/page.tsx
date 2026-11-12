import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { DemoButton } from "@/components/demo-button";
import { HeroVisual } from "@/components/landing/hero-visual";
import { Bento, MotionRoot, Reveal, Screens, Stats, Story } from "@/components/landing/sections";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

function SectionTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <Reveal className="mx-auto mb-12 max-w-2xl text-center">
      <p className="text-sm font-medium tracking-wider text-primary uppercase">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      <p className="mt-3 text-muted-foreground text-pretty">{text}</p>
    </Reveal>
  );
}

export default function Home() {
  return (
    <MotionRoot>
      <div className="relative flex min-h-dvh flex-col overflow-x-clip">
        {/* Soft light behind the top of the page. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px] bg-[radial-gradient(60%_50%_at_20%_0%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent),radial-gradient(50%_40%_at_90%_10%,color-mix(in_oklch,var(--info)_16%,transparent),transparent)]"
        />

        <header className="sticky top-0 z-40 border-b border-transparent bg-background/70 backdrop-blur-md supports-[backdrop-filter]:bg-background/50">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
            <Logo />
            <nav className="flex items-center gap-1 sm:gap-2">
              <Button variant="ghost" asChild className="hidden sm:inline-flex">
                <a href="#how">How it works</a>
              </Button>
              <Button variant="ghost" asChild>
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild>
                <Link href="/sign-up">Create account</Link>
              </Button>
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
          <section className="grid gap-12 pt-12 pb-16 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:pt-20 lg:pb-24">
            {/* Not animated: the headline is the first thing a visitor should see. */}
            <div className="flex flex-col gap-6">
              <span className="inline-flex w-fit items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
                <span className="size-1.5 rounded-full bg-ok" /> Product recalls, refunded through PayPal
              </span>
              <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
                Who is owed money, why, how much, and{" "}
                <span className="bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">what was actually paid.</span>
              </h1>
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
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="size-4 text-ok" aria-hidden />
                The demo uses 32 invented orders on a built-in PayPal simulator. No real money, no real customers.
              </p>
            </div>
            <Reveal delay={0.15}>
              <HeroVisual />
            </Reveal>
          </section>

          <section className="pb-24">
            <Reveal>
              <Stats />
            </Reveal>
            <p className="mt-3 text-center text-xs text-muted-foreground">From the demo case, measured against answers fixed in advance.</p>
          </section>

          <section className="pb-28">
            <SectionTitle
              eyebrow="The product"
              title="Every decision on one screen, and its reason next to it"
              text="Matching, approval and payment, each showing why. Move your mouse over the screens."
            />
            <Screens />
            <p className="mt-10 text-center text-xs text-muted-foreground">Simplified drawings of the app&apos;s screens. Names are invented.</p>
          </section>

          <section id="how" className="scroll-mt-24 pb-28">
            <SectionTitle
              eyebrow="How it works"
              title="From a supplier's notice to PayPal-confirmed refunds"
              text="Four steps. A person decides at every one that matters."
            />
            <Story />
          </section>

          <section className="pb-28">
            <SectionTitle
              eyebrow="Why it can be trusted"
              title="Built for the day money moves"
              text="The hard parts of a refund run are not the refunds. They are the duplicates, the guesses and the missing records."
            />
            <Bento />
          </section>

          <section className="pb-24">
            <Reveal>
              <div className="relative overflow-hidden rounded-3xl border bg-card px-6 py-14 text-center sm:px-12">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_80%_at_50%_100%,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)]"
                />
                <h2 className="relative text-3xl font-semibold tracking-tight text-balance sm:text-4xl">See a whole recall in two minutes</h2>
                <p className="relative mx-auto mt-3 max-w-xl text-muted-foreground">
                  The demo opens a shop with a recalled hand mixer, 32 orders and a PayPal simulator. Walk it from the notice to confirmed refunds.
                </p>
                <div className="relative mt-8 flex flex-wrap justify-center gap-3">
                  <DemoButton />
                  <Button size="lg" variant="ghost" asChild>
                    <Link href="/sign-up">
                      Create an account <ArrowRight />
                    </Link>
                  </Button>
                </div>
              </div>
            </Reveal>
          </section>
        </main>

        <footer className="border-t">
          <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
            <span>Make Good. PayPal sandbox and simulator only; live payments are switched off.</span>
            <span>AI proposes, people decide.</span>
          </div>
        </footer>
      </div>
    </MotionRoot>
  );
}
