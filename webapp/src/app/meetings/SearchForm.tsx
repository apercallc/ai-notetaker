"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { MAX_SEARCH_LENGTH } from "@/lib/meetingConstants";

export function SearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    const trimmed = query.trim();
    if (trimmed) params.set("q", trimmed);
    params.set("page", "1");
    startTransition(() => router.push(`/meetings?${params.toString()}`));
  }

  return (
    <form method="get" role="search" onSubmit={submit} aria-busy={pending}>
      <label className="sr-only" htmlFor="meeting-search">Search meetings</label>
      <div className="search-row">
        <input
          id="meeting-search"
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search meetings…"
          className="search-input"
          maxLength={MAX_SEARCH_LENGTH}
          disabled={pending}
        />
        <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
          {pending ? "Searching…" : "Search"}
        </button>
      </div>
    </form>
  );
}
