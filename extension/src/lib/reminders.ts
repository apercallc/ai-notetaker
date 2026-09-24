import { findMeetEventsStartingSoon, type CalendarEvent } from "./calendar";
import { meetingCodeFromPath } from "../meet/meetContext";
import type { RemindedCall } from "./storage";
import type { NotetakerSettings } from "../types";

export const REMINDER_ALARM = "ai-notetaker-meet-reminder";
const REMINDED_RETENTION_MS = 24 * 60 * 60_000;

export interface ReminderDeps {
  settings: Pick<NotetakerSettings, "calendar" | "calendarReminders">;
  isRecording: () => boolean;
  loadReminded: () => Promise<Record<string, RemindedCall>>;
  saveReminded: (calls: Record<string, RemindedCall>) => Promise<void>;
  notify: (id: string, notification: { title: string; message: string }) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: Date;
}

/** Stable per call and start time, so a recurring call is announced once per occurrence. */
export function reminderId(event: CalendarEvent): string {
  const code = event.meetUrl ? meetingCodeFromPath(new URL(event.meetUrl).pathname) : null;
  return `meet-reminder:${code ?? event.title}:${event.startsAt}`;
}

export function reminderCopy(event: CalendarEvent): { title: string; message: string } {
  return {
    title: `${event.title || "Your call"} is starting`,
    message: "Click to open the call, then click the Notetaker icon once and press Start.",
  };
}

/** Returns how many reminders were shown. Never throws: a reminder is a convenience, not a dependency. */
export async function checkMeetReminders(deps: ReminderDeps): Promise<number> {
  const { calendar, calendarReminders } = deps.settings;
  if (!calendar || calendar.provider !== "google" || !calendarReminders) return 0;
  const now = deps.now ?? new Date();
  try {
    const reminded = await deps.loadReminded();
    const fresh = Object.fromEntries(Object.entries(reminded).filter(([, call]) => now.getTime() - call.at < REMINDED_RETENTION_MS));
    let shown = 0;
    if (!deps.isRecording()) {
      for (const event of await findMeetEventsStartingSoon(calendar, deps.fetchImpl, now)) {
        const id = reminderId(event);
        if (fresh[id] || !event.meetUrl) continue;
        await deps.notify(id, reminderCopy(event));
        fresh[id] = { url: event.meetUrl, at: now.getTime() };
        shown += 1;
      }
    }
    if (shown > 0 || Object.keys(fresh).length !== Object.keys(reminded).length) await deps.saveReminded(fresh);
    return shown;
  } catch {
    return 0;
  }
}
