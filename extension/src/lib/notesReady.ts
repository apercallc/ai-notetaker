import { getMeeting } from "./storage";

const PREFIX = "notes-ready:";

/** "Notes ready — Open": the person is usually back in the call or another tab by now. */
export async function notifyNotesReady(meetingId: string): Promise<void> {
  if (!chrome.notifications) return;
  const meeting = await getMeeting(meetingId).catch(() => undefined);
  await new Promise<void>((resolve) => {
    chrome.notifications.create(
      `${PREFIX}${meetingId}`,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Notes ready",
        message: meeting?.title ? `${meeting.title} — open your notes.` : "Your meeting notes are ready.",
        buttons: [{ title: "Open" }],
        priority: 1,
      },
      () => resolve(),
    );
  });
}

/** True when the notification was ours, and its meeting has been opened. */
export async function openNotesReady(notificationId: string): Promise<boolean> {
  if (!notificationId.startsWith(PREFIX)) return false;
  const meetingId = notificationId.slice(PREFIX.length);
  chrome.notifications.clear(notificationId);
  if (!meetingId) return true;
  await chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(meetingId)}`) });
  return true;
}
