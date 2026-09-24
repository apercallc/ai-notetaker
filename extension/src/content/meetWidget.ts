/**
 * Content script for meet.google.com. Shows the notes widget only on a call
 * route (abc-defg-hij), follows Meet's single-page navigation, and forwards
 * background events to the widget. It reads nothing from Meet's markup and
 * has no storage access: the background denies it (see background.ts).
 */
import styles from "./widget.css";
import { meetTitle, meetingCodeFromPath } from "../meet/meetContext";
import { MeetWidget } from "./widget";
import type { BackgroundToUiMessage, UiToBackgroundMessage } from "../lib/internalMessages";

const ROUTE_POLL_MS = 1000;

function inCall(): boolean {
  return meetingCodeFromPath(window.location.pathname) !== null;
}

let widget: MeetWidget | null = null;

function ensureWidget(): void {
  if (inCall()) {
    if (widget) return;
    widget = new MeetWidget({
      send: <T>(message: UiToBackgroundMessage) => chrome.runtime.sendMessage(message) as Promise<T>,
      titleHint: () => meetTitle(document.title, meetingCodeFromPath(window.location.pathname)),
      reload: () => window.location.reload(),
      styles,
    });
    void widget.mount();
  } else if (widget) {
    widget.destroy();
    widget = null;
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundToUiMessage) => {
  widget?.handleMessage(message);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void widget?.refresh();
});

ensureWidget();
window.addEventListener("popstate", ensureWidget);
window.setInterval(ensureWidget, ROUTE_POLL_MS);
