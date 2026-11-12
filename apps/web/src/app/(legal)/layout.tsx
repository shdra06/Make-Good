import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

const LEGAL_UPDATED = "12 November 2026";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Logo />
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link href="/ai" className="hover:text-foreground">
              How AI is used
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="mb-8 rounded-lg border border-hold/30 bg-hold/5 px-4 py-3 text-sm">
          Draft, last changed {LEGAL_UPDATED}. Make Good runs on the PayPal sandbox and simulator only; live payments are switched off. This text has not been
          reviewed by a lawyer and must be before the service handles real customers or real money.
        </p>
        <article className="flex flex-col gap-4 leading-relaxed [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:text-muted-foreground [&_li]:text-muted-foreground">
          {children}
        </article>
      </main>
    </div>
  );
}
