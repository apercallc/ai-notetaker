"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const MAX_INTERVAL_MS = 30_000;

/**
 * Re-fetches the current server-rendered page while something is in flight
 * (hosted processing), so "Processing…" turns into "Ready" without a manual
 * reload. Pauses while the tab is hidden and backs off (x1.5, capped at 30s)
 * so a long-running job does not re-render the whole page every few seconds.
 */
export function AutoRefresh({ active, intervalMs = 5_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let delay = intervalMs;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        delay = Math.min(Math.round(delay * 1.5), MAX_INTERVAL_MS);
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [active, intervalMs, router]);
  return null;
}
