import type { BackgroundController } from "../lib/backgroundController";
import { getMeeting } from "../lib/storage";
import type { MeetingMode } from "../types";
import type { MeetCaptureController } from "./meetCapture";
import { ACTIVE_CAPTURE_HINT, CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT } from "./hints";
import { isMeetUrl, meetTitleForTab } from "./meetContext";
import { savePendingMeetStart, clearPendingMeetStartFor } from "./pendingStart";

export interface StartMeetOptions {
  tabId?: number;
  meetingMode?: MeetingMode;
  titleHint?: string;
  /**
   * Auto-attempt from the join watcher: failures are never broadcast (the
   * user did not click anything), and Chrome's invocation gate still saves
   * the one-click pending intent.
   */
  silent?: boolean;
}

/**
 * Chrome only hands out a tab-capture stream after the user has invoked the
 * extension on that tab (toolbar click, popup, or a registered shortcut).
 * These are the messages Chrome uses when that has not happened yet.
 */
const NOT_INVOKED_PATTERN = /(not (?:been )?invoked|activeTab)/i;
const ACTIVE_STREAM_PATTERN = /active stream/i;

export { ACTIVE_CAPTURE_HINT, CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT };

const MIC_DENIED_PATTERN = /permission (denied|dismissed)|notallowed|microphone access/i;

export function describeCaptureFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === MIC_PERMISSION_HINT || MIC_DENIED_PATTERN.test(message)) return MIC_PERMISSION_HINT;
  if (ACTIVE_STREAM_PATTERN.test(message)) return ACTIVE_CAPTURE_HINT;
  if (NOT_INVOKED_PATTERN.test(message)) return CAPTURE_PERMISSION_HINT;
  return message || "Google Meet capture could not start.";
}

/**
 * The single path for starting a Meet recording, shared by the popup, the
 * in-call widget, and the keyboard shortcut. Returns the meeting id, or "" when
 * the start failed and the failure has already been broadcast.
 *
 * Everything that can fail cheaply (no Meet tab, no microphone, Chrome not yet
 * told to allow tab capture) is checked before any meeting record exists, so a
 * start that cannot work leaves no "Failed" meeting in the history.
 */
export async function startMeetRecording(
  controller: BackgroundController,
  capture: MeetCaptureController,
  options: StartMeetOptions,
): Promise<string> {
  const active = controller.getState().activeMeeting;
  if (active) {
    // Reuse is only correct when the active meeting is itself a Meet capture.
    // A desktop-helper recording must not be handed back to the widget as if
    // Meet audio were being captured — the user would see "Recording" while
    // no Meet audio ever lands. Only one capture of each kind can be active,
    // and desktop + Meet genuinely cannot run at once (both claim the mic),
    // so surface a busy error instead of silently doing nothing.
    const activeRecord = await getMeeting(active.id);
    if (activeRecord?.captureSource === "meet") return active.id;
    controller.reportStartFailure(
      "A desktop recording is already running in the AI Notetaker helper. Stop it before starting notes for this call.",
    );
    return "";
  }
  const discoveredTab = typeof options.tabId === "number" ? undefined : await discoverActiveMeetTab();
  const tabId = options.tabId ?? discoveredTab?.id;
  const titleHint = options.titleHint ?? (discoveredTab ? meetTitleForTab(discoveredTab) : undefined);
  if (typeof tabId !== "number") {
    controller.reportStartFailure("Open the Google Meet call in this tab first, then start notes.");
    return "";
  }
  try {
    await capture.preflight(tabId);
  } catch (error) {
    const description = describeCaptureFailure(error);
    // Chrome's activeTab gate: the widget's click cannot be the first
    // invocation. Remember the start so the toolbar click that opens the
    // popup completes it — one click total instead of click-then-click.
    if (description === CAPTURE_PERMISSION_HINT) await savePendingMeetStart({ tabId, ...(options.meetingMode ? { meetingMode: options.meetingMode } : {}), ...(titleHint ? { titleHint } : {}) });
    if (!options.silent) controller.reportStartFailure(description);
    return "";
  }
  const meetingId = await controller.startRecording(options.meetingMode, "meet", titleHint);
  if (!meetingId) return "";
  try {
    await capture.start(tabId, meetingId);
  } catch (error) {
    const description = describeCaptureFailure(error);
    if (description === CAPTURE_PERMISSION_HINT) await savePendingMeetStart({ tabId, ...(options.meetingMode ? { meetingMode: options.meetingMode } : {}), ...(titleHint ? { titleHint } : {}) });
    if (options.silent) {
      // Auto-attempt: tear down quietly; the saved intent makes the user's
      // next toolbar click the one-click start.
      await controller.abortStart(meetingId, description).catch(() => undefined);
    } else {
      await controller.abortStart(meetingId, description);
    }
    return "";
  }
  // A start that succeeded (from the widget, the popup, or the shortcut —
  // the shortcut press is itself the invocation) retires any remembered
  // handoff for this tab, so the next popup open never double-starts.
  await clearPendingMeetStartFor(tabId);
  return meetingId;
}

/**
 * Popup callers do not have a sender tab. Find the active Meet tab in the
 * focused browser window so starting from the toolbar behaves like starting
 * from the in-call widget, without asking the user to copy a tab id.
 */
async function discoverActiveMeetTab(): Promise<{ id: number; url?: string; title?: string } | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find((candidate) => typeof candidate.id === "number" && isMeetUrl(candidate.url));
    return tab && typeof tab.id === "number" ? { id: tab.id, url: tab.url, title: tab.title } : undefined;
  } catch {
    return undefined;
  }
}

export async function stopMeetRecording(
  controller: BackgroundController,
  capture: MeetCaptureController,
  meetingId: string,
): Promise<void> {
  try {
    if (capture.isActive(meetingId)) await capture.stop(meetingId);
  } finally {
    await controller.stopRecording(meetingId);
  }
}

/**
 * A captured Meet tab was closed, or left its call. That is the end of the
 * call, not a failure: the audio is already on disk, so finish the meeting the
 * same way Stop does and write the notes. `nextUrl` is the tab's new address
 * for a navigation; a URL that is still the same call (query or hash change)
 * leaves the capture running.
 */
export async function finishMeetCaptureForTab(
  controller: BackgroundController,
  capture: MeetCaptureController,
  tabId: number,
  nextUrl?: string,
): Promise<void> {
  const meetingIds = await capture.stopForTab(tabId, nextUrl);
  await Promise.all(
    meetingIds.map((meetingId) =>
      controller.stopRecording(meetingId).catch((error) => {
        console.warn("Could not finish the Meet recording after its tab ended", { meetingId, error });
      }),
    ),
  );
}

/** Handles the manifest `commands`. The shortcut press is itself the user invocation Chrome requires. */
export async function handleMeetCommand(
  command: string,
  tab: { id?: number; url?: string; title?: string } | undefined,
  controller: BackgroundController,
  capture: MeetCaptureController,
): Promise<void> {
  const active = controller.getState().activeMeeting;
  if (command === "add-bookmark") {
    if (active) await controller.addBookmark(active.id);
    return;
  }
  if (command !== "toggle-recording") return;
  if (active) {
    await stopMeetRecording(controller, capture, active.id);
    return;
  }
  // The shortcut is global; outside a Meet tab there is nothing to capture, and
  // starting anyway would leave a failed meeting behind.
  if (!isMeetUrl(tab?.url)) return;
  const titleHint = meetTitleForTab(tab);
  await startMeetRecording(controller, capture, { tabId: tab?.id, ...(titleHint ? { titleHint } : {}) });
}
