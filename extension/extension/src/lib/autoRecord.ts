import { isMeetUrl, meetingCodeFromPath } from "./meetContext";
import { savePendingMeetStart } from "../meet/pendingStart";
import { describeCaptureFailure } from "../meet/session";
import { CAPTURE_PERMISSION_HINT } from "../meet/hints";

/**
 * Auto-record on joining a Google Meet call (opt-in setting).
 *
 * Chrome's honest limit: tab capture is refused until the extension has been
 * invoked on that tab — a toolbar-icon click or the keyboard shortcut. A tab
 * the user just opened or navigated into a call has usually NOT been invoked,
 * so a zero-click start is impossible for the first join of that tab.
 *
 * What this watcher does instead:
 * 1. When a tab lands on a Meet call URL and the setting is on, immediately
 *    attempt to start notes (the call may already be joined from a tab the
 *    user invoked earlier — e.g. they clicked the icon once this session).
 * 2. If Chrome's invocation gate blocks it, remember the intent SILENTLY
 *    (no error broadcast — the user never asked for a recording to fail in
 *    their face). The next toolbar-icon click on that tab starts recording
 *    on that single click, via the existing pendingStart handoff.
 *
 * Join detection is URL-based only (never Meet DOM scraping), consistent with
 * meetContext.ts.
 */

/** Tabs we already attempted for their current call, so one join = one attempt. */
const attemptedTabs = new Map<number, string>();

export function resetAutoRecordTrackingForTests(): void {
  attemptedTabs.clear();
}

function isAutoStartableUrl(url: string | undefined): boolean {
  if (!isMeetUrl(url)) return false;
  try {
    return meetingCodeFromPath(new URL(url).pathname) !== null;
  } catch {
    return false;
  }
}

interface AutoStartDeps {
  /** Current settings snapshot provider. */
  getSettings: () => Promise<{ autoRecordOnMeetJoin: boolean; onboardingComplete: boolean; consentDisclosureAcknowledged: boolean }>;
  /** Whether a recording is already live. */
  isRecordingActive: () => boolean;
  /** Attempt a Meet start; returns a meeting id or "". */
  startMeetRecording: (options: { tabId: number }) => Promise<string>;
}

/** Handles a tab-update/navigation event; returns true when a start was attempted. */
export async function maybeAutoStartMeetRecording(
  tabId: number,
  url: string | undefined,
  deps: AutoStartDeps,
): Promise<boolean> {
  if (!isAutoStartableUrl(url)) return false;
  const callCode = meetingCodeFromPath(new URL(url as string).pathname) as string;
  if (attemptedTabs.get(tabId) === callCode) return false;
  const settings = await deps.getSettings();
  if (!settings.autoRecordOnMeetJoin || !settings.onboardingComplete || !settings.consentDisclosureAcknowledged) return false;
  if (deps.isRecordingActive()) return false;
  attemptedTabs.set(tabId, callCode);
  try {
    const meetingId = await deps.startMeetRecording({ tabId });
    return meetingId !== "";
  } catch (error) {
    // Chrome's invocation gate is the expected first-join outcome. The start
    // path already saved a pending intent in that case; anything else is a
    // real failure we must not surface — the user never clicked anything.
    const description = describeCaptureFailure(error);
    if (description !== CAPTURE_PERMISSION_HINT) {
      // Swallow silently: auto-attempts are best-effort by design. The widget
      // and popup remain the explicit, user-driven paths.
    }
    return false;
  }
}

/** A tab leaving its call (or closing) makes it eligible again for a new join. */
export function clearAutoRecordAttempt(tabId: number, nextUrl?: string): void {
  if (nextUrl === undefined || !isAutoStartableUrl(nextUrl)) {
    attemptedTabs.delete(tabId);
    return;
  }
  const nextCode = meetingCodeFromPath(new URL(nextUrl).pathname);
  const attempted = attemptedTabs.get(tabId);
  if (attempted !== undefined && attempted !== nextCode) attemptedTabs.delete(tabId);
}

/** The disclosure text users can paste into Meet chat (meetDisclosureNotice setting). */
export const MEET_DISCLOSURE_TEXT =
  "Heads up: I'm using AI Notetaker to transcribe and summarize this call. The recording stays on my device unless I choose to share the notes.";
