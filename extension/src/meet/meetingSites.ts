import { isMeetUrl, meetingCodeFromPath } from "./meetContext";

/** Keep these in sync with the widget's manifest matches; never inject the
 * Meet MAIN-world audio bridge into other sites. */
export const MEETING_TAB_PATTERNS = [
  "https://meet.google.com/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://teams.cloud.microsoft/*",
  "https://*.zoom.us/*",
  "https://discord.com/*",
  "https://app.slack.com/*",
];

/** Recognizes web app routes, not whether a participant has joined a call.
 * Teams, Discord and Slack share their call UI with chat routes. */
export function hasMeetingWidget(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port) return false;
    if (url.hostname === "meet.google.com") return isMeetUrl(value) && meetingCodeFromPath(url.pathname) !== null;
    if (["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(url.hostname)) {
      return !/^\/(?:login|logout|downloads)(?:\/|$)/i.test(url.pathname);
    }
    if (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")) return url.pathname.startsWith("/wc/");
    if (url.hostname === "discord.com") return url.pathname.startsWith("/channels/");
    if (url.hostname === "app.slack.com") return /^\/(?:client|huddle)\//.test(url.pathname);
    return false;
  } catch {
    return false;
  }
}
