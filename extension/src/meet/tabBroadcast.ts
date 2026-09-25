import type { BackgroundToUiMessage } from "../lib/internalMessages";

export const MEET_TAB_PATTERN = "https://meet.google.com/*";

/**
 * chrome.runtime.sendMessage only reaches extension pages, never content
 * scripts, so the in-call widget needs each Meet tab addressed directly.
 * Tabs without a listening widget reject the send; that is expected.
 */
export async function broadcastToMeetTabs(message: BackgroundToUiMessage): Promise<void> {
  if (!chrome.tabs?.query) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: MEET_TAB_PATTERN });
  } catch {
    return;
  }
  await Promise.all(
    tabs
      .filter((tab) => message.type !== "CAPTURE_INVOCATION_REQUIRED" || tab.id === message.tabId)
      .map(async (tab) => {
        if (typeof tab.id !== "number") return;
        try {
          await chrome.tabs.sendMessage(tab.id, message);
        } catch {
          // No widget in this tab (still loading, or a non-call Meet page).
        }
      }),
  );
}
