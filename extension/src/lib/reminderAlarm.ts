import { isMeetUrl } from "../meet/meetContext";
import { REMINDER_ALARM, REMINDER_BUTTON_OPEN, REMINDER_POLL_MINUTES, checkMeetReminders } from "./reminders";
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
  if (!(await chrome.alarms.get(REMINDER_ALARM))) chrome.alarms.create(REMINDER_ALARM, { periodInMinutes: REMINDER_POLL_MINUTES });
}

export async function runMeetReminders(isRecording: () => boolean): Promise<number> {
  return checkMeetReminders({
    settings: await getSettings(),
    isRecording,
    loadReminded: getRemindedCalls,
    saveReminded: saveRemindedCalls,
    notify: (id, { title, message }) =>
      new Promise<void>((resolve) => {
        chrome.notifications.create(
          id,
          {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title,
            message,
            priority: 1,
            // One tap on the notification itself does the same thing; the button makes that visible.
            buttons: [{ title: REMINDER_BUTTON_OPEN }],
          },
          () => resolve(),
        );
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

/**
 * The notification's "Open call" button. Chrome only lets an extension capture
 * a tab after the user invokes the extension on it (toolbar, shortcut, popup),
 * and a notification button is not such an invocation, so recording itself
 * cannot start from here: the button takes the user to the call, where the
 * Notetaker pill starts notes in one click.
 */
export async function handleReminderButton(notificationId: string, buttonIndex: number): Promise<boolean> {
  if (buttonIndex !== 0) return false;
  return openReminderCall(notificationId);
}

/**
 * Registered when this module loads, i.e. synchronously in the service worker's
 * top-level run, so Chrome can deliver the event that woke the worker. Guarded
 * for browsers without the notifications API.
 */
export function registerReminderNotificationHandlers(): void {
  chrome.notifications?.onButtonClicked?.addListener((notificationId, buttonIndex) => {
    void handleReminderButton(notificationId, buttonIndex).catch((error) => console.warn("Reminder button failed", error));
  });
}

registerReminderNotificationHandlers();
