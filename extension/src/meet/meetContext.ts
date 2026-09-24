/**
 * Pure helpers for recognising a Google Meet call and naming it. Kept free of
 * DOM and chrome.* access so the service worker, the content script, and the
 * tests can all share them. Meet's own markup is deliberately never scraped:
 * everything here comes from the URL and the tab title, which are stable.
 */

const MEET_HOST = /(^|\.)meet\.google\.com$/i;
const MEETING_CODE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i;
const TITLE_PREFIX = /^\s*meet\s*[-–—:]\s*/i;
const TITLE_SUFFIX = /\s*[-–—]\s*google meet\s*$/i;

export function isMeetUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && MEET_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** `abc-defg-hij` for a call route, `null` for the Meet home page or settings routes. */
export function meetingCodeFromPath(pathname: string): string | null {
  const match = MEETING_CODE.exec(pathname);
  return match?.[1]?.toLowerCase() ?? null;
}

/** A human title for the recording: the tab title when it names the meeting, else the code. */
export function meetTitle(tabTitle: string | undefined, code: string | null): string | undefined {
  const cleaned = (tabTitle ?? "").replace(TITLE_PREFIX, "").replace(TITLE_SUFFIX, "").replace(/\s+/g, " ").trim();
  const isJustTheCode = cleaned === "" || (code !== null && cleaned.toLowerCase() === code) || /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(cleaned);
  if (!isJustTheCode && cleaned.toLowerCase() !== "google meet") return cleaned.slice(0, 200);
  return code ? `Google Meet ${code}` : undefined;
}

/** Title for a tab URL + title pair as seen from the service worker. */
export function meetTitleForTab(tab: { url?: string; title?: string } | undefined): string | undefined {
  if (!tab?.url || !isMeetUrl(tab.url)) return undefined;
  return meetTitle(tab.title, meetingCodeFromPath(new URL(tab.url).pathname));
}
