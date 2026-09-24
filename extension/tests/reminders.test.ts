import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMeetEventsStartingSoon, resetCalendarCaches, REMINDER_GRACE_MS, REMINDER_LEAD_MS, type CalendarConnection } from "../src/lib/calendar";
import { checkMeetReminders, reminderCopy, reminderId, type ReminderDeps } from "../src/lib/reminders";
import type { RemindedCall } from "../src/lib/storage";

const NOW = new Date("2026-09-24T15:00:00.000Z");

beforeEach(() => resetCalendarCaches());
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

const connection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  provider: "google",
  clientId: "c",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: at(3_600_000),
  ...overrides,
});

function googleEvents(items: Array<Record<string, unknown>>): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => ({ items }) })) as unknown as typeof fetch;
}

const meetEvent = (startOffsetMs: number, extra: Record<string, unknown> = {}) => ({
  summary: "Weekly sync",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  start: { dateTime: at(startOffsetMs) },
  end: { dateTime: at(startOffsetMs + 1_800_000) },
  ...extra,
});

describe("Meet links on calendar events", () => {
  it("reads the Meet link from hangoutLink or the video entry point, and ignores other conferencing", async () => {
    const fetchImpl = googleEvents([
      meetEvent(0),
      meetEvent(0, { summary: "Via conference data", hangoutLink: undefined, conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" }] } }),
      meetEvent(0, { summary: "Zoom call", hangoutLink: undefined, conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123" }] } }),
      meetEvent(0, { summary: "Lookalike", hangoutLink: "https://meet.google.com.evil.example/abc-defg-hij" }),
    ]);

    const events = await findMeetEventsStartingSoon(connection(), fetchImpl, NOW);

    expect(events.map((event) => [event.title, event.meetUrl])).toEqual([
      ["Weekly sync", "https://meet.google.com/abc-defg-hij"],
      ["Via conference data", "https://meet.google.com/xyz-abcd-efg"],
    ]);
  });

  it("only returns calls starting within the lead time or just after they began", async () => {
    const fetchImpl = googleEvents([
      meetEvent(REMINDER_LEAD_MS - 1_000, { summary: "About to start" }),
      meetEvent(-REMINDER_GRACE_MS + 1_000, { summary: "Just started" }),
      meetEvent(REMINDER_LEAD_MS + 60_000, { summary: "Too early" }),
      meetEvent(-REMINDER_GRACE_MS - 60_000, { summary: "Long underway" }),
    ]);

    const events = await findMeetEventsStartingSoon(connection(), fetchImpl, NOW);

    expect(events.map((event) => event.title)).toEqual(["About to start", "Just started"]);
  });

  it("returns nothing, and never throws, when the calendar cannot be read", async () => {
    const failing = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await findMeetEventsStartingSoon(connection(), failing, NOW)).toEqual([]);
    const denied = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    expect(await findMeetEventsStartingSoon(connection(), denied, NOW)).toEqual([]);
  });
});

describe("polling cost", () => {
  it("refreshes an expired token once, not on every minute's check", async () => {
    const expired = connection({ expiresAt: at(-60_000) });
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("oauth2.googleapis.com")
        ? { ok: true, json: async () => ({ access_token: "fresh", expires_in: 3600 }) }
        : { ok: true, json: async () => ({ items: [meetEvent(30_000)] }) },
    ) as unknown as typeof fetch;

    await findMeetEventsStartingSoon(expired, fetchImpl, NOW);
    await findMeetEventsStartingSoon(expired, fetchImpl, new Date(NOW.getTime() + 60_000));
    await findMeetEventsStartingSoon(expired, fetchImpl, new Date(NOW.getTime() + 120_000));

    const urls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((call) => String(call[0]));
    expect(urls.filter((url) => url.includes("oauth2.googleapis.com"))).toHaveLength(1);
  });

  it("fetches the day's events once per few minutes but still moves the reminder window forward", async () => {
    const fetchImpl = googleEvents([meetEvent(180_000, { summary: "Later" })]);

    expect(await findMeetEventsStartingSoon(connection(), fetchImpl, NOW)).toEqual([]);
    const later = new Date(NOW.getTime() + 2 * 60_000);
    expect((await findMeetEventsStartingSoon(connection(), fetchImpl, later)).map((event) => event.title)).toEqual(["Later"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await findMeetEventsStartingSoon(connection(), fetchImpl, new Date(NOW.getTime() + 4 * 60_000));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("checkMeetReminders", () => {
  it("notifies once for a call about to start, then stays quiet on the next check", async () => {
    const saved: Array<Record<string, RemindedCall>> = [];
    const notify = vi.fn(async () => undefined);
    let store: Record<string, RemindedCall> = {};
    const base: ReminderDeps = {
      settings: { calendar: connection(), calendarReminders: true },
      isRecording: () => false,
      loadReminded: async () => store,
      saveReminded: async (next) => { store = next; saved.push(next); },
      notify,
      fetchImpl: googleEvents([meetEvent(30_000)]),
      now: NOW,
    };

    expect(await checkMeetReminders(base)).toBe(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^meet-reminder:abc-defg-hij:/), {
      title: "Weekly sync is starting",
      message: expect.stringContaining("click the Notetaker icon once"),
    });
    expect(Object.values(store)[0]?.url).toBe("https://meet.google.com/abc-defg-hij");

    expect(await checkMeetReminders(base)).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("stays silent when reminders are off, the calendar is not Google, or nothing is connected", async () => {
    const notify = vi.fn(async () => undefined);
    const run = (settings: ReminderDeps["settings"]) =>
      checkMeetReminders({ settings, isRecording: () => false, loadReminded: async () => ({}), saveReminded: async () => {}, notify, fetchImpl: googleEvents([meetEvent(30_000)]), now: NOW });

    expect(await run({ calendar: connection(), calendarReminders: false })).toBe(0);
    expect(await run({ calendar: connection({ provider: "outlook" }), calendarReminders: true })).toBe(0);
    expect(await run({ calendar: null, calendarReminders: true })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not interrupt a recording that is already running", async () => {
    const notify = vi.fn(async () => undefined);
    const shown = await checkMeetReminders({ settings: { calendar: connection(), calendarReminders: true }, isRecording: () => true, loadReminded: async () => ({}), saveReminded: async () => {}, notify, fetchImpl: googleEvents([meetEvent(30_000)]), now: NOW });
    expect(shown).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("forgets calls older than a day so the record cannot grow without bound", async () => {
    let store: Record<string, RemindedCall> = {
      old: { url: "https://meet.google.com/aaa-bbbb-ccc", at: NOW.getTime() - 25 * 3_600_000 },
      recent: { url: "https://meet.google.com/ddd-eeee-fff", at: NOW.getTime() - 3_600_000 },
    };
    await checkMeetReminders({ settings: { calendar: connection(), calendarReminders: true }, isRecording: () => false, loadReminded: async () => store, saveReminded: async (next) => { store = next; }, notify: async () => {}, fetchImpl: googleEvents([]), now: NOW });
    expect(Object.keys(store)).toEqual(["recent"]);
  });

  it("never throws, even when storage or notifications fail", async () => {
    const shown = await checkMeetReminders({ settings: { calendar: connection(), calendarReminders: true }, isRecording: () => false, loadReminded: async () => { throw new Error("storage"); }, saveReminded: async () => {}, notify: async () => {}, fetchImpl: googleEvents([meetEvent(30_000)]), now: NOW });
    expect(shown).toBe(0);
    const failingNotify = await checkMeetReminders({ settings: { calendar: connection(), calendarReminders: true }, isRecording: () => false, loadReminded: async () => ({}), saveReminded: async () => {}, notify: async () => { throw new Error("blocked"); }, fetchImpl: googleEvents([meetEvent(30_000)]), now: NOW });
    expect(failingNotify).toBe(0);
  });
});

describe("reminder copy and ids", () => {
  it("identifies a recurring call by its code and start time", () => {
    const event = { title: "Standup", attendees: [], startsAt: at(0), endsAt: at(1_000), meetUrl: "https://meet.google.com/abc-defg-hij" };
    expect(reminderId(event)).toBe(`meet-reminder:abc-defg-hij:${at(0)}`);
    expect(reminderId({ ...event, startsAt: at(86_400_000) })).not.toBe(reminderId(event));
  });

  it("falls back to a generic title and tells the truth about the one-click step", () => {
    const copy = reminderCopy({ title: "", attendees: [], startsAt: at(0), endsAt: at(1_000) });
    expect(copy.title).toBe("Your call is starting");
    expect(copy.message).toMatch(/Notetaker icon once/);
  });
});
