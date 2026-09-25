import type { ActionItem, ActionItemStatus, MeetingRecord } from "../types";

export type ActionFilter = "all" | ActionItemStatus;
export type DueState = "none" | "upcoming" | "today" | "overdue";

export interface ActionRow {
  meeting: MeetingRecord;
  item: ActionItem;
  index: number;
  status: ActionItemStatus;
}

/** Only the three known filters are honored; anything else in the URL means "all". */
export function parseFilter(value: string | null): ActionFilter {
  return value === "open" || value === "done" ? value : "all";
}

/** YYYY-MM-DD in the user's local time, the same shape due dates are stored and edited in. */
export function localDateKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Done items are never overdue; an open item is overdue once its due date is before today. */
export function dueState(status: ActionItemStatus, dueDate: string | null | undefined, now: Date): DueState {
  const due = dueDate?.slice(0, 10);
  if (!due) return "none";
  if (status === "done") return "upcoming";
  const today = localDateKey(now);
  if (due < today) return "overdue";
  return due === today ? "today" : "upcoming";
}

/**
 * Open items first, soonest due date first (undated items last), most recent
 * meeting first within a tie, then completed items in the same order.
 */
export function sortActionRows<T extends ActionRow>(rows: T[]): T[] {
  const key = (row: T): [number, string, string] => [
    row.status === "done" ? 1 : 0,
    row.item.dueAt ? row.item.dueAt.slice(0, 10) : "9999-99-99",
    row.meeting.startedAt,
  ];
  return [...rows].sort((a, b) => {
    const [aDone, aDue, aStart] = key(a);
    const [bDone, bDue, bStart] = key(b);
    if (aDone !== bDone) return aDone - bDone;
    if (aDue !== bDue) return aDue < bDue ? -1 : 1;
    if (aStart !== bStart) return aStart < bStart ? 1 : -1;
    return a.index - b.index;
  });
}
