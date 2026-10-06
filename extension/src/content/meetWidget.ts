/**
 * Content script for supported meeting web apps. Follows single-page
 * navigation and forwards
 * background events to the widget. It reads nothing from Meet's markup and
 * has no storage access: the background denies it (see background.ts).
 */
import styles from "./widget.css";
import { browserTitleForTab } from "../meet/meetContext";
import { hasMeetingWidget } from "../meet/meetingSites";
import { MeetWidget } from "./widget";
import type { BackgroundToUiMessage, UiToBackgroundMessage } from "../lib/internalMessages";

const ROUTE_POLL_MS = 1000;

function inCall(): boolean {
  return hasMeetingWidget(window.location.href);
}

let widget: MeetWidget | null = null;

function ensureWidget(): void {
  if (inCall()) {
    if (widget) return;
    widget = new MeetWidget({
      send: <T>(message: UiToBackgroundMessage) => chrome.runtime.sendMessage(message) as Promise<T>,
      titleHint: () => browserTitleForTab({ url: window.location.href, title: document.title }),
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
  if (document.visibilityState === "visible") void widget?.resume();
});

ensureWidget();
window.addEventListener("popstate", ensureWidget);
// Meet navigates without reloading (pushState), which fires no popstate. The
// Navigation API reports those changes from the browser side, so the content
// script's isolated world sees them too; browsers without it keep the slow poll.
const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
if (navigation) navigation.addEventListener("currententrychange", ensureWidget);
else window.setInterval(ensureWidget, ROUTE_POLL_MS);
