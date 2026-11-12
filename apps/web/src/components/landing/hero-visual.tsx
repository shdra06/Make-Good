"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};
import type { Phase } from "./recall-scene";

// Three.js is only downloaded for this picture, and only in the browser.
const RecallScene = dynamic(() => import("./recall-scene"), { ssr: false, loading: () => <SceneFallback /> });

const CAPTIONS: Record<Phase, { step: string; text: string }> = {
  0: { step: "32 orders", text: "Every order the shop shipped, from its own records." },
  1: { step: "Find the batch", text: "A scan finds the 23 orders from recalled batch B-2217." },
  2: { step: "Hold the unclear", text: "5 records do not agree. They wait for a person, not a guess." },
  3: { step: "Refund through PayPal", text: "20 proven refunds go through PayPal, each with a fixed request ID." },
  4: { step: "PayPal confirmed", text: "A customer turns green only when PayPal confirms. Paid twice: 0." },
};

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Shown while the 3D loads, and instead of it where WebGL is missing. */
function SceneFallback() {
  return (
    <div aria-hidden className="grid size-full place-items-center">
      <div className="grid grid-cols-8 gap-2 opacity-60">
        {Array.from({ length: 32 }, (_, i) => (
          <span key={i} className={`size-3 rounded-sm ${i % 3 === 0 ? "bg-ok" : "bg-muted-foreground/40"}`} />
        ))}
      </div>
    </div>
  );
}

export function HeroVisual() {
  // The server cannot know the visitor's motion setting, so the first render assumes motion and matches the server.
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const prefersReduced = useReducedMotion() ?? false;
  const reduce = hydrated && prefersReduced;
  const box = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(0);
  const [visible, setVisible] = useState(true);
  const [gl, setGl] = useState<boolean | null>(null);

  useEffect(() => {
    // Checked after mount: the server cannot know. The state update is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGl(webglAvailable());
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const shown = reduce ? 4 : phase;
  return (
    <div className="relative">
      <div className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--info)_22%,transparent),transparent)] blur-2xl" />
      <div
        ref={box}
        className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border bg-card/40 shadow-2xl shadow-black/10 backdrop-blur-sm"
        role="img"
        aria-label="An animation: 32 orders, 23 from the recalled batch are found, 5 unclear ones are held, and 20 refunds flow through PayPal to customers who turn green when PayPal confirms."
      >
        <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_oklch,var(--border)_60%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_60%,transparent)_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_80%)]" />
        {gl === false ? <SceneFallback /> : gl ? <RecallScene onPhase={setPhase} still={reduce} paused={!visible} /> : null}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between px-4 pt-3 text-[11px] font-medium text-muted-foreground">
          <span>Shop orders</span>
          <span>PayPal</span>
          <span>Customers</span>
        </div>
      </div>
      <div className="mt-4 flex items-start gap-3" aria-live="polite">
        <ol className="flex shrink-0 gap-1.5 pt-1.5" aria-hidden>
          {[0, 1, 2, 3, 4].map((p) => (
            <li
              key={p}
              className={`h-1.5 rounded-full transition-all duration-500 ${p === shown ? "w-6 bg-primary" : p < shown ? "w-1.5 bg-primary/50" : "w-1.5 bg-muted-foreground/30"}`}
            />
          ))}
        </ol>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={shown}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="text-sm text-muted-foreground"
          >
            <span className="font-medium text-foreground">{CAPTIONS[shown].step}.</span> {CAPTIONS[shown].text}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
