/**
 * MV3 service worker entry point. Thin by design — all real logic lives in
 * backgroundController.ts (unit tested there); this file only wires that
 * logic to actual chrome.* APIs and re-runs on every wake, since MV3 kills
 * this worker after ~30s idle and re-executes top-level code on the next
 * event (see extension/CLAUDE.md and the architecture spec §3.2).
 */
import { maybeAutoStartMeetRecording, clearAutoRecordAttempt } from "./lib/autoRecord";
import { getSettings } from "./lib/storage";
import { BackgroundController } from "./lib/backgroundController";
import { getExtensionOnboardingUrl } from "./lib/install";
import { handleInstalled } from "./lib/installHandler";
import { notifyNotesReady, openNotesReady } from "./lib/notesReady";
import { setBadge, type BadgeState } from "./lib/recordingBadge";
import type { BackgroundToUiMessage, UiToBackgroundMessage } from "./lib/internalMessages";
import { NativeMessagingClient } from "./lib/nativeMessaging";
import { openReminderCall, runMeetReminders, syncReminderAlarm } from "./lib/reminderAlarm";
import { REMINDER_ALARM } from "./lib/reminders";
import { classifySender, isMessageAllowed, resolveStartRequest, type SenderKind } from "./lib/senderPolicy";
import { saveWidgetPosition } from "./lib/storage";
import { MeetCaptureController, type MeetAudioChunk } from "./meet/meetCapture";
import { finishMeetCaptureForTab, handleMeetCommand, startMeetRecording, stopMeetRecording } from "./meet/session";
import { broadcastToMeetTabs } from "./meet/tabBroadcast";

// API keys and calendar tokens live in chrome.storage.local. Keep it out of
// reach of content scripts (the Meet widget runs next to a web page); every
// widget need goes through a background message instead.
async function restrictStorageToTrustedContexts(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error) {
    console.warn("Could not restrict chrome.storage.local to trusted contexts", error);
  }
}
void restrictStorageToTrustedContexts();

const client = new NativeMessagingClient();
const controller = new BackgroundController(client, broadcastToUi);
const meetCapture = new MeetCaptureController((pcm16, meetingId, channel) => controller.sendMeetAudioChunk(meetingId, channel, pcm16, 48_000));

// Declared before any listener that needs it: a tab event can wake the
// worker at any point during top-level execution, and referencing a later
// const from a listener would hit the temporal dead zone.
// Restore the persisted capture map before the controller rehydrates
// meeting state, so a tab-close event arriving during this same wake finds
// the capture and finishes the meeting instead of stranding it.
const readyPromise = (async () => {
  await meetCapture.restoreCaptures();
  await controller.init();
})();

// A captured tab that closes, or leaves its call, is the end of the call and
// not a failure: the audio is already on disk, so finish the meeting the way
// Stop does and write the notes. Same-call URL changes (query, hash) are ignored.
//
// Both paths MUST await the controller's ready promise: the worker may have
// just been woken by this very tab event, and finishMeetCaptureForTab needs
// the rehydrated meeting state (active id, chunk sequence, settings) that
// init() restores from storage — calling it before init resolves would see
// stale in-memory state and strand the meeting in "recording" with a stuck
// REC badge.
chrome.tabs.onRemoved?.addListener((tabId) => {
  clearAutoRecordAttempt(tabId);
  void readyPromise
    .then(() => finishMeetCaptureForTab(controller, meetCapture, tabId))
    .catch((error) => {
      console.warn("Meet capture cleanup after tab removal failed", error);
    });
});
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url !== "string") return;
  void readyPromise
    .then(() => finishMeetCaptureForTab(controller, meetCapture, tabId, changeInfo.url))
    .catch((error) => {
      console.warn("Meet capture cleanup after tab navigation failed", error);
    });
  // Auto-record (opt-in): a tab landing on a Meet call URL attempts a start.
  // clearAutoRecordAttempt re-arms per-call eligibility as tabs move on.
  void readyPromise
    .then(() =>
      maybeAutoStartMeetRecording(tabId, changeInfo.url, {
        getSettings,
        isRecordingActive: () => controller.getState().activeMeeting !== null,
        startMeetRecording: (options) => startMeetRecording(controller, meetCapture, { ...options, silent: true }),
      }),
    )
    .then(() => clearAutoRecordAttempt(tabId, changeInfo.url))
    .catch(() => undefined);
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "ai-notetaker-helper-retry") client.retryFromAlarm();
  if (alarm.name === REMINDER_ALARM) void readyPromise.then(() => runMeetReminders(() => controller.getState().activeMeeting !== null));
});

async function openNotification(notificationId: string): Promise<void> {
  if (!(await openNotesReady(notificationId))) await openReminderCall(notificationId);
}
chrome.notifications?.onClicked.addListener((notificationId) => void openNotification(notificationId));
chrome.notifications?.onButtonClicked?.addListener((notificationId) => void openNotification(notificationId));

chrome.runtime.onInstalled?.addListener((details) => {
  void handleInstalled(details).catch((error) => console.warn("Install handling failed", error));
});

chrome.commands?.onCommand.addListener((command, tab) => {
  void readyPromise
    .then(() => handleMeetCommand(command, tab, controller, meetCapture))
    .catch((error) => console.warn("Meet shortcut failed", error));
});

function broadcastToUi(message: BackgroundToUiMessage): void {
  // No listener (e.g. popup closed) rejects this silently — that's fine,
  // the UI reads persisted state from storage when it next opens.
  chrome.runtime.sendMessage(message).catch(() => {});
  void broadcastToMeetTabs(message);

  updateBadge(message);
  if (message.type === "SUMMARY_READY") void notifyNotesReady(message.meetingId).catch(() => {});
}

// "REC" while a recording is live. A failure that happens while the person is
// looking at something else (mid-call, or while notes were being written) is
// the moment a passive label in the history is not enough, so it gets a "!"
// that stays until the popup is opened. A start that fails is reported in
// place, to whoever pressed start, and never badges.
let badge: BadgeState = "";
function showBadge(next: BadgeState): void {
  badge = next;
  setBadge(next);
}
function updateBadge(message: BackgroundToUiMessage): void {
  if (message.type === "RECORDING_ERROR" && message.phase !== "start") {
    showBadge("!");
    return;
  }
  const recording = controller.getState().activeMeeting !== null;
  if (recording) showBadge("REC");
  else if (badge === "REC") showBadge("");
}

void readyPromise.then(syncReminderAlarm);
void readyPromise.then(() => {
  if (controller.getState().activeMeeting) showBadge("REC");
});

chrome.runtime.onMessage.addListener((message: UiToBackgroundMessage, sender, sendResponse) => {
  // Extension pages and the offscreen capture page share this channel with the
  // Meet content script, which runs next to a web page. Each sender may only
  // send the requests it needs.
  const kind = classifySender(sender, {
    extensionId: chrome.runtime.id,
    extensionBaseUrl: chrome.runtime.getURL(""),
    offscreenUrl: chrome.runtime.getURL("meet/offscreen.html"),
  });
  if (typeof message?.type !== "string" || !isMessageAllowed(message.type, kind)) return false;
  handleUiMessage(message, sender, kind).then(sendResponse, (error: unknown) => {
    console.warn(`Handling ${message.type} failed`, error);
    sendResponse({ error: error instanceof Error ? error.message : "The request failed." });
  });
  return true; // keep the message channel open for the async response
});

async function openExtensionPage(page: Extract<UiToBackgroundMessage, { type: "OPEN_PAGE" }>["page"], fromTabId?: number): Promise<void> {
  if (page === "settings") {
    await chrome.runtime.openOptionsPage();
    return;
  }
  const urls: Record<Exclude<typeof page, "settings">, string> = {
    // All in-call widget setup actions originate from a Meet tab. Keep that
    // path explicit so Chrome cannot restore an old desktop selection and
    // send the user to the helper installer.
    onboarding: getExtensionOnboardingUrl(chrome.runtime.getURL("")),
    // Opened from the call: remember which tab to hand focus back to once the
    // microphone is allowed.
    microphone: chrome.runtime.getURL(`meet/microphone.html${typeof fromTabId === "number" ? `?returnTo=${fromTabId}` : ""}`),
    shortcuts: "chrome://extensions/shortcuts",
  };
  await chrome.tabs.create({ url: urls[page] });
}

async function handleUiMessage(message: UiToBackgroundMessage, sender: chrome.runtime.MessageSender, kind: SenderKind): Promise<unknown> {
  await readyPromise;
  switch (message.type) {
    case "GET_STATE":
      // Opening the popup acknowledges a failure badge; a live recording keeps its own.
      showBadge(controller.getState().activeMeeting ? "REC" : "");
      return controller.getState();
    case "CHECK_HELPER":
      return controller.checkHelper();
    case "GET_AUDIO_PREFLIGHT":
      return { status: await controller.getAudioPreflight() };
    case "RUN_AUDIO_PROBE":
      return { result: await controller.runAudioProbe() };
    case "START_RECORDING": {
      // The in-call widget cannot know its own tab id; the sender does, and a
      // page-side sender is never allowed to name another one.
      const { captureSource, tabId } = resolveStartRequest(message, kind, sender.tab?.id);
      const meetingId =
        captureSource === "meet"
          ? await startMeetRecording(controller, meetCapture, {
              tabId,
              ...(message.meetingMode ? { meetingMode: message.meetingMode } : {}),
              ...(message.titleHint ? { titleHint: message.titleHint } : {}),
            })
          : await controller.startRecording(message.meetingMode, captureSource, message.titleHint);
      return { meetingId };
    }
    case "STOP_RECORDING":
      // A page-side sender may only stop the recording that is actually live.
      if (kind === "meet-content-script" && controller.getState().activeMeeting?.id !== message.meetingId) return {};
      await stopMeetRecording(controller, meetCapture, message.meetingId);
      return {};
    case "ADD_BOOKMARK":
      return { ok: await controller.addBookmark(message.meetingId, message.note) };
    case "GET_WIDGET_STATE":
      return controller.getWidgetState();
    case "SAVE_WIDGET_POSITION":
      await saveWidgetPosition(message.position);
      return {};
    case "OPEN_PAGE":
      await openExtensionPage(message.page, sender.tab?.id);
      return {};
    case "OPEN_MEETING":
      await chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(message.meetingId)}`) });
      return {};
    case "RETRY_MEETING_PROCESSING":
      await controller.retryProcessing(message.meetingId);
      return {};
    case "RETRY_DRIVE_EXPORT":
      await controller.retryDriveExport(message.meetingId);
      return {};
    case "MEET_AUDIO_CHUNK":
      try {
        if (!meetCapture.isActive(message.meetingId) && controller.getState().activeMeeting?.id === message.meetingId) meetCapture.recover(message.meetingId, message.tabId);
        await meetCapture.forwardChunk(message as MeetAudioChunk);
      } catch (error) {
        await controller.failRecording(message.meetingId, error instanceof Error ? error.message : "Meet audio capture failed.");
        void meetCapture.stop(message.meetingId).catch(() => {});
        return { error: "Call audio could not be saved. Start notes again." };
      }
      return {};
    case "MEET_CAPTURE_ERROR":
      await meetCapture.stop(message.meetingId);
      await controller.failRecording(message.meetingId, message.message.slice(0, 500) || "Meet audio capture failed.");
      return {};
    case "MEET_LIVE_TRANSCRIPT_STATUS":
      await controller.updateMeetLiveTranscriptStatus(message.meetingId, message.status);
      return {};
    case "MEET_LIVE_TRANSCRIPT_UPDATE":
      await controller.addMeetLiveTranscript(message);
      return {};
    case "SAVE_SETTINGS":
      await controller.saveSettings(message.settings);
      await syncReminderAlarm();
      return {};
    case "RESUME_RECORDING":
      controller.resumeRecording(message.meetingId);
      return {};
    case "DISCARD_RECORDING":
      await controller.discardRecording(message.meetingId);
      return {};
    case "DELETE_MEETING":
      await controller.deleteMeeting(message.meetingId);
      return {};
    case "TEST_PROVIDER_KEY":
      // Always direct from the extension (see lib/testProviderKey.ts). The
      // desktop flag is accepted for older UI pages but no longer routes
      // through the helper, so setup is never blocked by a missing helper.
      return controller.testProviderKey(message.provider, message.key);
  }
}
