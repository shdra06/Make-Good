"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

/** Each app page fades in when you move to it. Skipped for visitors who ask for less motion. */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}
