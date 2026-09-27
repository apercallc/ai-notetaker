"use client";

import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useRef, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { MAX_SEARCH_LENGTH } from "@/lib/meetingConstants";

const LIVE_SEARCH_DELAY_MS = 350;

/**
 * Search stays typeable the whole time. Results follow the input after a
 * short pause (useDeferredValue keeps typing responsive while the server
 * render is in flight) and Enter searches immediately.
 */
export function SearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [seenInitial, setSeenInitial] = useState(initialQuery);
  const deferred = useDeferredValue(query);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  // Browser back/forward changes the URL under us; follow it.
  if (seenInitial !== initialQuery) {
    setSeenInitial(initialQuery);
    setQuery(initialQuery);
  }

  function go(value: string, mode: "push" | "replace") {
    const params = new URLSearchParams();
    const trimmed = value.trim();
    if (trimmed) params.set("q", trimmed);
    const href = params.size ? `/meetings?${params.toString()}` : "/meetings";
    startTransition(() => (mode === "push" ? router.push(href) : router.replace(href)));
  }

  useEffect(() => {
    const next = deferred.trim();
    if (next === initialQuery.trim()) return;
    const timer = setTimeout(() => go(deferred, "replace"), LIVE_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // `go` only closes over the router and transition starter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, initialQuery]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go(query, "push");
  }

  function clear() {
    setQuery("");
    go("", "replace");
    input.current?.focus();
  }

  return (
    <form method="get" action="/meetings" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor="meeting-search">Search meetings</label>
      <div className="search-row">
        <div className="search-field">
          <input
            ref={input}
            id="meeting-search"
            type="search"
            name="q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles, summaries and transcripts"
            className="search-input"
            maxLength={MAX_SEARCH_LENGTH}
            autoComplete="off"
          />
          {query && (
            <button type="button" className="search-clear" onClick={clear} aria-label="Clear search">
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
        <button type="submit" className="button button-primary">Search</button>
      </div>
      <span className="sr-only" role="status">{pending ? "Searching…" : ""}</span>
    </form>
  );
}
