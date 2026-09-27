import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { handleReminderButton, openReminderCall, registerReminderNotificationHandlers, runMeetReminders, syncReminderAlarm } from "../src/lib/reminderAlarm";
import { REMINDER_ALARM } from "../src/lib/reminders";
import { resetCalendarCaches } from "../src/lib/calendar";
import { saveRemindedCalls, saveSettings } from "../src/lib/storage";
import { DEFAULT_SETTINGS } from "../src/types";

const google = { provider: "google" as const, clientId: "c", accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

function installChrome() {
  const alarms = { get: vi.fn(async () => undefined as unknown), create: vi.fn(), clear: vi.fn(async () => true) };
  const notifications = { create: vi.fn((_id: string, _options: unknown, callback?: () => void) => callback?.()), clear: vi.fn() };
  const tabs = { create: vi.fn(async () => ({})) };
  Object.assign(chromeMock, { alarms, notifications });
  Object.assign(chromeMock.tabs, tabs);
  return { alarms, notifications, tabs };
}

beforeEach(() => {
  chromeMock.reset();
  resetCalendarCaches();
  vi.restoreAllMocks();
});

describe("syncReminderAlarm", () => {
  it("registers one repeating alarm only while a Google calendar has reminders on", async () => {
    const { alarms } = installChrome();
    await saveSettings({ ...DEFAULT_SETTINGS, calendar: google, calendarReminders: true });

    await syncReminderAlarm();
    expect(alarms.create).toHaveBeenCalledWith(REMINDER_ALARM, { periodInMinutes: 5 });

    alarms.get.mockResolvedValue({ name: REMINDER_ALARM });
    await syncReminderAlarm();
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });

  it("removes the alarm when reminders are off, the calendar is not Google, or nothing is connected", async () => {
    const { alarms } = installChrome();
    for (const settings of [
      { ...DEFAULT_SETTINGS, calendar: google, calendarReminders: false },
      { ...DEFAULT_SETTINGS, calendar: { ...google, provider: "outlook" as const }, calendarReminders: true },
      { ...DEFAULT_SETTINGS, calendar: null },
    ]) {
      await saveSettings(settings);
      await syncReminderAlarm();
    }
    expect(alarms.clear).toHaveBeenCalledTimes(3);
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it("does nothing on a browser without the alarms API", async () => {
    Object.assign(chromeMock, { alarms: undefined });
    await expect(syncReminderAlarm()).resolves.toBeUndefined();
  });
});

describe("runMeetReminders", () => {
  it("shows a notification for a call about to start, once", async () => {
    const { notifications } = installChrome();
    await saveSettings({ ...DEFAULT_SETTINGS, calendar: google, calendarReminders: true });
    const start = new Date(Date.now() + 30_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ summary: "Weekly sync", hangoutLink: "https://meet.google.com/abc-defg-hij", start: { dateTime: start }, end: { dateTime: new Date(Date.now() + 1_800_000).toISOString() } }] }),
    })));

    expect(await runMeetReminders(() => false)).toBe(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.stringMatching(/^meet-reminder:abc-defg-hij:/),
      expect.objectContaining({ type: "basic", title: "Weekly sync is starting", buttons: [{ title: "Open call" }] }),
      expect.any(Function),
    );
    expect(await runMeetReminders(() => false)).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe("openReminderCall", () => {
  it("opens the remembered Meet call and clears the notification", async () => {
    const { tabs, notifications } = installChrome();
    await saveRemindedCalls({ n1: { url: "https://meet.google.com/abc-defg-hij", at: 1 } });

    expect(await openReminderCall("n1")).toBe(true);
    expect(tabs.create).toHaveBeenCalledWith({ url: "https://meet.google.com/abc-defg-hij" });
    expect(notifications.clear).toHaveBeenCalledWith("n1");
  });

  it("refuses an unknown notification or a stored URL that is not a Meet call", async () => {
    const { tabs } = installChrome();
    await saveRemindedCalls({ bad: { url: "https://evil.example/abc-defg-hij", at: 1 } });

    expect(await openReminderCall("missing")).toBe(false);
    expect(await openReminderCall("bad")).toBe(false);
    expect(tabs.create).not.toHaveBeenCalled();
  });
});

describe("reminder notification button", () => {
  it("opens the call from the Open call button and ignores other buttons", async () => {
    const { tabs } = installChrome();
    await saveRemindedCalls({ n1: { url: "https://meet.google.com/abc-defg-hij", at: 1 } });

    expect(await handleReminderButton("n1", 1)).toBe(false);
    expect(tabs.create).not.toHaveBeenCalled();
    expect(await handleReminderButton("n1", 0)).toBe(true);
    expect(tabs.create).toHaveBeenCalledWith({ url: "https://meet.google.com/abc-defg-hij" });
  });

  it("registers the button listener only where the notifications API exists", async () => {
    Object.assign(chromeMock, { notifications: undefined });
    expect(() => registerReminderNotificationHandlers()).not.toThrow();

    const onButtonClicked = { addListener: vi.fn() };
    Object.assign(chromeMock, { notifications: { onButtonClicked, create: vi.fn(), clear: vi.fn() } });
    registerReminderNotificationHandlers();
    expect(onButtonClicked.addListener).toHaveBeenCalledTimes(1);

    const { tabs } = installChrome();
    await saveRemindedCalls({ n2: { url: "https://meet.google.com/xyz-abcd-efg", at: 1 } });
    const listener = onButtonClicked.addListener.mock.calls[0]![0] as (id: string, index: number) => void;
    listener("n2", 0);
    await vi.waitFor(() => expect(tabs.create).toHaveBeenCalledWith({ url: "https://meet.google.com/xyz-abcd-efg" }));
  });
});
