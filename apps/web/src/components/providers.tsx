"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { ApiError } from "@/lib/api";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 4xx will not get better by asking again; a network blip might.
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {/* Every animation in the app respects the visitor's "reduce motion" setting. */}
      <MotionConfig reducedMotion="user">
        {children}
        <Toaster position="bottom-right" richColors closeButton duration={6000} />
      </MotionConfig>
    </QueryClientProvider>
  );
}
