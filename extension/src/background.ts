/**
 * MV3 service worker entry point. Thin by design — all real logic lives in
 * backgroundController.ts (unit tested there); this file only wires that
 * logic to actual chrome.* APIs and re-runs on every wake, since MV3 kills
 * this worker after ~30s idle and re-executes top-level code on the next
 * event (see extension/CLAUDE.md and the architecture spec §3.2).
 */
import { BackgroundController } from "./lib/backgroundController";
import { getInstallPageUrl } from "./lib/install";
import type { BackgroundToUiMessage, UiToBackgroundMessage } from "./lib/internalMessages";
import { NativeMessagingClient } from "./lib/nativeMessaging";
import { openReminderCall, runMeetReminders, syncReminderAlarm } from "./lib/reminderAlarm";
import { REMINDER_ALARM } from "./lib/reminders";
import { classifySender, isMessageAllowed, resolveStartRequest, type SenderKind } from "./lib/senderPolicy";
import { saveWidgetPosition } from "./lib/storage";
import { MeetCaptureController, type MeetAudioChunk } from "./meet/meetCapture";
import { handleMeetCommand, startMeetRecording, stopMeetRecording } from "./meet/session";
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
const meetCapture = new MeetCaptureController((pcm16, meetingId, channel) => {
  try {
    controller.sendMeetAudioChunk(meetingId, channel, pcm16, 48_000);
  } catch (error) {
    console.warn("Meet audio chunk could not reach the helper", error);
    void controller.failRecording(meetingId, "The desktop helper disconnected during Google Meet capture. The audio already received is safe; reconnect and start again.");
    void meetCapture.stop(meetingId);
  }
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "ai-notetaker-helper-retry") client.retryFromAlarm();
  if (alarm.name === REMINDER_ALARM) void readyPromise.then(() => runMeetReminders(() => controller.getState().activeMeeting !== null));
});

chrome.notifications?.onClicked.addListener((notificationId) => void openReminderCall(notificationId));

// The onboarding wizard (helper install → select device → API key(s)) is
// the architecture's whole "simple, straightforward install" pillar — it
// did nothing on its own until this listener existed, since nothing else
// ever opened it automatically on first install.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
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

  // A recording failure is exactly the moment the user is *not* looking at
  // the popup (they're in the call it just failed to capture) — without a
  // toolbar badge, the only trace was a passive label buried in history,
  // discoverable only if they happened to reopen the popup and scroll down
  // (design review finding, see TODO.md). The badge is cleared the next
  // time the popup actually opens (see GET_STATE below).
  if (message.type === "RECORDING_ERROR") {
    void chrome.action.setBadgeBackgroundColor({ color: "#c62828" }); // matches --color-danger-solid
    void chrome.action.setBadgeText({ text: "!" });
  }
}

const readyPromise = controller.init();
void readyPromise.then(syncReminderAlarm);

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

async function openExtensionPage(page: Extract<UiToBackgroundMessage, { type: "OPEN_PAGE" }>["page"]): Promise<void> {
  if (page === "settings") {
    await chrome.runtime.openOptionsPage();
    return;
  }
  const urls: Record<Exclude<typeof page, "settings">, string> = {
    onboarding: chrome.runtime.getURL("onboarding/onboarding.html"),
    microphone: chrome.runtime.getURL("meet/microphone.html"),
    shortcuts: "chrome://extensions/shortcuts",
    install: getInstallPageUrl("meet-widget"),
  };
  await chrome.tabs.create({ url: urls[page] });
}

async function handleUiMessage(message: UiToBackgroundMessage, sender: chrome.runtime.MessageSender, kind: SenderKind): Promise<unknown> {
  await readyPromise;
  switch (message.type) {
    case "GET_STATE":
      void chrome.action.setBadgeText({ text: "" });
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
      await openExtensionPage(message.page);
      return {};
    case "OPEN_MEETING":
      await chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(message.meetingId)}`) });
      return {};
    case "RETRY_DRIVE_EXPORT":
      await controller.retryDriveExport(message.meetingId);
      return {};
    case "MEET_AUDIO_CHUNK":
      try {
        meetCapture.forwardChunk(message as MeetAudioChunk);
      } catch (error) {
        await controller.failRecording(message.meetingId, error instanceof Error ? error.message : "Meet audio capture failed.");
      }
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
      return controller.testProviderKey(message.provider, message.key);
  }
}
