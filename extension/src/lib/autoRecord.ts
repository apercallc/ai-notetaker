import { isMeetUrl, meetingCodeFromPath } from "../meet/meetContext";

/** Honest first-use copy: Chrome's invocation gate is a single click, not a second Start action. */
export const MEET_AUTO_RECORD_GUIDANCE =
  "Auto-record starts when you join. If Chrome blocks the first start, click the Notetaker toolbar icon once in that Meet tab; recording starts from that click, with no extra Start notes step.";

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
 * 2. If Chrome's invocation gate blocks it, the start path saves a pending
 *    intent SILENTLY (no error broadcast — an auto-attempt the user never
 *    asked about must not fail in their face). The next toolbar-icon click on
 *    that tab starts recording on that single click.
 *
 * Join detection is URL-based only (never Meet DOM scraping), consistent with
 * meetContext.ts.
 */

/** Tabs we already attempted for their current call, so one join = one attempt. */
const attemptedTabs = new Map<number, string>();

export function resetAutoRecordTrackingForTests(): void {
  attemptedTabs.clear();
}

function callCodeOfUrl(url: string | undefined): string | null {
  if (!url || !isMeetUrl(url)) return null;
  try {
    return meetingCodeFromPath(new URL(url).pathname);
  } catch {
    return null;
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
  const callCode = callCodeOfUrl(url);
  if (!callCode) return false;
  if (attemptedTabs.get(tabId) === callCode) return false;
  const settings = await deps.getSettings();
  if (!settings.autoRecordOnMeetJoin || !settings.onboardingComplete || !settings.consentDisclosureAcknowledged) return false;
  if (deps.isRecordingActive()) return false;
  attemptedTabs.set(tabId, callCode);
  try {
    const meetingId = await deps.startMeetRecording({ tabId });
    return meetingId !== "";
  } catch {
    // Chrome's invocation gate is the expected first-join outcome: the start
    // path (session.ts) saved a pending intent for the one-click handoff.
    // Any other failure is swallowed too — auto-attempts are best-effort,
    // and the widget/popup remain the explicit, user-driven paths.
    return false;
  }
}

/** A tab leaving its call (or closing) makes it eligible again for a new join. */
export function clearAutoRecordAttempt(tabId: number, nextUrl?: string): void {
  const nextCode = callCodeOfUrl(nextUrl);
  if (nextCode === null) {
    attemptedTabs.delete(tabId);
    return;
  }
  const attempted = attemptedTabs.get(tabId);
  if (attempted !== undefined && attempted !== nextCode) attemptedTabs.delete(tabId);
}

/** The disclosure text users can paste into Meet chat (meetDisclosureNotice setting). */
export const MEET_DISCLOSURE_TEXT =
  "Heads up: I'm using AI Notetaker to transcribe and summarize this call. Please let me know if you have any concerns.";
