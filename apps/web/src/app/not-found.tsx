import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="text-2xl font-semibold">This page does not exist</h1>
        <p className="text-sm text-muted-foreground">The link may be old, or the address may have a typo.</p>
        <Button asChild>
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
