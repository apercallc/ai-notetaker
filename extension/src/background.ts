/**
 * MV3 service worker entry point. Thin by design — all real logic lives in
 * backgroundController.ts (unit tested there); this file only wires that
 * logic to actual chrome.* APIs and re-runs on every wake, since MV3 kills
 * this worker after ~30s idle and re-executes top-level code on the next
 * event (see extension/CLAUDE.md and the architecture spec §3.2).
 */
import { BackgroundController } from "./lib/backgroundController";
import { NativeMessagingClient } from "./lib/nativeMessaging";
import type { BackgroundToUiMessage, UiToBackgroundMessage } from "./lib/internalMessages";

const client = new NativeMessagingClient();
const controller = new BackgroundController(client, broadcastToUi);

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "ai-notetaker-helper-retry") client.retryFromAlarm();
});

// The onboarding wizard (helper install → select device → API key(s)) is
// the architecture's whole "simple, straightforward install" pillar — it
// did nothing on its own until this listener existed, since nothing else
// ever opened it automatically on first install.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

function broadcastToUi(message: BackgroundToUiMessage): void {
  // No listener (e.g. popup closed) rejects this silently — that's fine,
  // the UI reads persisted state from storage when it next opens.
  chrome.runtime.sendMessage(message).catch(() => {});

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

chrome.runtime.onMessage.addListener((message: UiToBackgroundMessage, _sender, sendResponse) => {
  void handleUiMessage(message).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleUiMessage(message: UiToBackgroundMessage): Promise<unknown> {
  await readyPromise;
  switch (message.type) {
    case "GET_STATE":
      void chrome.action.setBadgeText({ text: "" });
      return controller.getState();
    case "GET_AUDIO_PREFLIGHT":
      return { status: await controller.getAudioPreflight() };
    case "RUN_AUDIO_PROBE":
      return { result: await controller.runAudioProbe() };
    case "START_RECORDING":
      return { meetingId: await controller.startRecording(message.meetingMode) };
    case "STOP_RECORDING":
      await controller.stopRecording(message.meetingId);
      return {};
    case "SAVE_SETTINGS":
      await controller.saveSettings(message.settings);
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
