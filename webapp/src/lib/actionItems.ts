// Client-safe helpers for action items (no Node-only imports).

export interface ActionItemLike {
  text: string;
  owner: string | null;
  status: "open" | "done";
  dueAt: string | null;
}

/** Today's date in UTC as YYYY-MM-DD. Due dates are stored as UTC midnight. */
export function utcDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The value an `<input type="date">` expects, or "" when there is no due date. */
export function dueDateInputValue(dueAt: string | null): string {
  return dueAt ? dueAt.slice(0, 10) : "";
}

/** True for date strings that are real calendar days, e.g. rejects 2026-02-31. */
export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An open item whose due day is before today (UTC). */
export function isOverdue(item: { status: "open" | "done"; dueAt: string | null }, now: Date = new Date()): boolean {
  if (item.status !== "open" || !item.dueAt) return false;
  return dueDateInputValue(item.dueAt) < utcDateString(now);
}

/** One checklist line: `- [ ] Send notes (Sam) — due 2026-10-01`. */
export function actionItemLine(item: ActionItemLike): string {
  const owner = item.owner ? ` (${item.owner})` : "";
  const due = item.dueAt ? ` — due ${dueDateInputValue(item.dueAt)}` : "";
  return `- [${item.status === "done" ? "x" : " "}] ${item.text}${owner}${due}`;
}

export function actionItemsToText(items: readonly ActionItemLike[]): string {
  return items.map(actionItemLine).join("\n");
}
