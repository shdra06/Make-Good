"use client";

import { ROLE_LABELS } from "@makegood/shared";
import { Activity, AlertTriangle, BarChart3, LayoutDashboard, Loader2, LogOut, Menu, Plug, Settings, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { VerifyBanner } from "@/components/verify-banner";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/primitives";
import { chooseOrg, useMe, useOrg, useSignOut } from "@/lib/session";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/connections", label: "Connections", icon: Plug },
  { href: "/team", label: "Team", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
              active && "bg-accent text-accent-foreground hover:bg-accent",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const org = useOrg();
  const signOut = useSignOut();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (me.data === null) router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [me.data, pathname, router]);

  if (me.isPending || me.data === null) {
    return (
      <div className="grid min-h-dvh place-items-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <Alert className="max-w-md">{me.error.message}</Alert>
      </div>
    );
  }

  const { user, organisations, server } = me.data;

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Logo href="/dashboard" className="px-2" />
      {org ? (
        <div className="rounded-lg border bg-card px-3 py-2">
          {organisations.length > 1 ? (
            <>
              <label htmlFor="workspace" className="sr-only">
                Workspace
              </label>
              <select
                id="workspace"
                className="w-full truncate bg-transparent text-sm font-medium outline-none"
                value={org.orgId}
                onChange={(e) => {
                  chooseOrg(e.target.value);
                  router.push("/dashboard");
                }}
              >
                {organisations.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <p className="truncate text-sm font-medium">{org.name}</p>
          )}
          <p className="text-xs text-muted-foreground">{ROLE_LABELS[org.role]}</p>
        </div>
      ) : null}
      <NavLinks onNavigate={() => setMenuOpen(false)} />
      <div className="mt-auto flex flex-col gap-2 border-t pt-4">
        <p className="truncate px-2 text-sm">{user.name}</p>
        <p className="truncate px-2 text-xs text-muted-foreground">{user.email}</p>
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          <LogOut /> Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r bg-sidebar lg:block">{sidebar}</aside>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-black/40" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-sidebar">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((v) => !v)}>
            {menuOpen ? <X /> : <Menu />}
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {server.livePayPalAllowed ? <Badge tone="stop">Live PayPal allowed</Badge> : <Badge tone="info">PayPal: sandbox or simulator, no real money</Badge>}
            {server.aiConfigured ? <Badge tone="neutral">AI: {server.aiModel}</Badge> : <Badge tone="neutral">AI off</Badge>}
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          <VerifyBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
