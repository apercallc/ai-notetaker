"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const POLL_MS = 3_000;
const MAX_POLLS = 10;

/**
 * Returning from Stripe Checkout, the subscription only becomes active when
 * Stripe's webhook lands. Re-render the server page a few times until it does,
 * so the owner sees the new plan without reloading.
 */
export function CheckoutRefresh({ waiting }: { waiting: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!waiting) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      router.refresh();
      if (polls >= MAX_POLLS) clearInterval(timer);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, router]);
  return null;
}
