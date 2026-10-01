/** How many meetings the popup paints at once; a long archive is revealed in steps, never all at once. */
export const HISTORY_PAGE_SIZE = 20;
/** Meetings shown before the person asks to browse everything or searches. */
export const HISTORY_RECENT_COUNT = 5;
export const SEARCH_DEBOUNCE_MS = 200;

export function pageOf<T>(items: T[], shown: number): { visible: T[]; remaining: number } {
  const visible = items.slice(0, Math.max(0, shown));
  return { visible, remaining: items.length - visible.length };
}

export function historyHeading(query: string, browsingAll: boolean): string {
  if (query) return "Search results";
  return browsingAll ? "All meetings" : "Recent meetings";
}

export function resultsSummary(total: number, query: string): string {
  if (!query) return "";
  return `${total} ${total === 1 ? "match" : "matches"}`;
}
