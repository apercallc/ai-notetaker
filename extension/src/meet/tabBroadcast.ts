import { MEETING_TAB_PATTERNS } from "./meetingSites";
import type { BackgroundToUiMessage } from "../lib/internalMessages";

export const MEET_TAB_PATTERN = "https://meet.google.com/*";

/**
 * chrome.runtime.sendMessage only reaches extension pages, never content
 * scripts, so the in-call widget needs each Meet tab addressed directly.
 * Tabs without a listening widget reject the send; that is expected.
 */
export async function broadcastToMeetTabs(message: BackgroundToUiMessage, ownerTabId?: number): Promise<void> {
  const global = message.type === "MEETING_STATE_CHANGED" || message.type === "HELPER_STATUS";
  const target = message.type === "CAPTURE_INVOCATION_REQUIRED" ? message.tabId
    : message.type === "RECORDING_ERROR" ? message.tabId ?? ownerTabId : ownerTabId;
  if (!global && target === undefined) return;
  if (!chrome.tabs?.query) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: MEETING_TAB_PATTERNS });
  } catch {
    return;
  }
  await Promise.all(
    tabs
      .filter((tab) => global || tab.id === target)
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
