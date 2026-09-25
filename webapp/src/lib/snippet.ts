// Search-result excerpts and highlighting. Postgres does the matching
// (case-insensitive substring); this only decides what to *show*, so it
// needs no schema change. Results are plain parts, rendered as <mark> by
// React — never as HTML.

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** Split `text` into parts, flagging every case-insensitive occurrence of `query`. */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLocaleLowerCase();
  const lowered = needle.toLocaleLowerCase();
  // toLocaleLowerCase can change length for a few scripts; fall back to
  // plain text rather than slicing at the wrong offsets.
  if (haystack.length !== text.length) return [{ text, match: false }];
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (;;) {
    const found = haystack.indexOf(lowered, cursor);
    if (found === -1) break;
    if (found > cursor) parts.push({ text: text.slice(cursor, found), match: false });
    parts.push({ text: text.slice(found, found + lowered.length), match: true });
    cursor = found + lowered.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/**
 * A short excerpt centred on the first occurrence of `query`, or `null` when
 * the text does not contain it.
 */
export function makeSnippet(text: string, query: string, radius = 70): HighlightPart[] | null {
  const needle = query.trim();
  if (!needle) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index === -1 || flat.length !== flat.toLocaleLowerCase().length) return null;
  const start = Math.max(0, index - radius);
  const end = Math.min(flat.length, index + needle.length + radius);
  const excerpt = `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  return highlightParts(excerpt, needle);
}
