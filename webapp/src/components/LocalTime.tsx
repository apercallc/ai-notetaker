"use client";

import { useSyncExternalStore } from "react";

type Style = "datetime" | "date" | "time";

const OPTIONS: Record<Style, Intl.DateTimeFormatOptions> = {
  datetime: { dateStyle: "medium", timeStyle: "short" },
  date: { dateStyle: "medium" },
  time: { timeStyle: "short" },
};

const subscribe = () => () => {};

/**
 * Renders a timestamp in the *viewer's* locale and time zone. The server
 * doesn't know either (on a hosted deployment it is UTC/en-US), so it renders
 * a UTC fallback that the browser replaces right after hydration —
 * useSyncExternalStore keeps that swap free of hydration mismatches.
 */
export function LocalTime({ iso, style = "datetime" }: { iso: string; style?: Style }) {
  const text = useSyncExternalStore(
    subscribe,
    () => new Date(iso).toLocaleString(undefined, OPTIONS[style]),
    () => new Date(iso).toLocaleString("en-US", { ...OPTIONS[style], timeZone: "UTC" }),
  );
  return <time dateTime={iso}>{text}</time>;
}
