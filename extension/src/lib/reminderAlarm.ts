import { isMeetUrl } from "../meet/meetContext";
import { REMINDER_ALARM, checkMeetReminders } from "./reminders";
import { getRemindedCalls, getSettings, saveRemindedCalls } from "./storage";

/** The alarm exists only while it has work to do, so an unconfigured extension never wakes. */
export async function syncReminderAlarm(): Promise<void> {
  if (!chrome.alarms) return;
  const settings = await getSettings();
  const wanted = settings.calendar?.provider === "google" && settings.calendarReminders;
  if (!wanted) {
    await chrome.alarms.clear(REMINDER_ALARM);
    return;
  }
  if (!(await chrome.alarms.get(REMINDER_ALARM))) chrome.alarms.create(REMINDER_ALARM, { periodInMinutes: 1 });
}

export async function runMeetReminders(isRecording: () => boolean): Promise<number> {
  return checkMeetReminders({
    settings: await getSettings(),
    isRecording,
    loadReminded: getRemindedCalls,
    saveReminded: saveRemindedCalls,
    notify: (id, { title, message }) =>
      new Promise<void>((resolve) => {
        chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message, priority: 1 }, () => resolve());
      }),
  });
}

/** Opens the call a reminder was about, only if it is still a Meet URL. */
export async function openReminderCall(notificationId: string): Promise<boolean> {
  const call = (await getRemindedCalls())[notificationId];
  chrome.notifications.clear(notificationId);
  if (!call || !isMeetUrl(call.url)) return false;
  await chrome.tabs.create({ url: call.url });
  return true;
}
