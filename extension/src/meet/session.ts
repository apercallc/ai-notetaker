import type { BackgroundController } from "../lib/backgroundController";
import type { MeetingMode } from "../types";
import type { MeetCaptureController } from "./meetCapture";
import { ACTIVE_CAPTURE_HINT, CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT } from "./hints";
import { isMeetUrl, meetTitleForTab } from "./meetContext";

export interface StartMeetOptions {
  tabId: number | undefined;
  meetingMode?: MeetingMode;
  titleHint?: string;
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
 * the start failed and the failure has already been recorded and broadcast.
 */
export async function startMeetRecording(
  controller: BackgroundController,
  capture: MeetCaptureController,
  options: StartMeetOptions,
): Promise<string> {
  const meetingId = await controller.startRecording(options.meetingMode, "meet", options.titleHint);
  if (!meetingId) return "";
  if (typeof options.tabId !== "number") {
    await controller.failRecording(meetingId, "Choose the active Google Meet tab before starting browser capture.");
    return "";
  }
  try {
    await capture.start(options.tabId, meetingId);
  } catch (error) {
    await controller.failRecording(meetingId, describeCaptureFailure(error));
    return "";
  }
  return meetingId;
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
