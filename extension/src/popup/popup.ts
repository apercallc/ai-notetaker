import { getMeeting, getSettings, listMeetings } from "../lib/storage";
import { createStopConfirm, STOP_CONFIRM_LABEL, STOP_LABEL } from "../lib/stopConfirm";
import type { BackgroundState, BackgroundToUiMessage } from "../lib/internalMessages";
import { speakerLabel, type AudioProbeResult, type AudioStatus, type ErrorRecoveryCategory, type MeetingMode, type MeetingRecord, type Speaker } from "../types";
import { escapeHtml } from "../lib/html";
import { getExtensionOnboardingUrl } from "../lib/install";
import { managedBillingUrl } from "../lib/managedClient";
import { isMeetUrl, meetTitleForTab } from "../meet/meetContext";
import { takePendingMeetStart } from "../meet/pendingStart";
import { HISTORY_PAGE_SIZE, HISTORY_RECENT_COUNT, SEARCH_DEBOUNCE_MS, historyHeading, pageOf, resultsSummary } from "./historyModel";
import { providerHostPermissions, requestOptionalPermission } from "../lib/optionalPermissions";
import { sendToBackground } from "../lib/sendToBackground";

const app = document.getElementById("app")!;
let removeLiveListener: (() => void) | null = null;
let quotaRefreshTimer: ReturnType<typeof setInterval> | null = null;
let historyQuery = "";
/** True once the person asks to browse the whole archive instead of the newest few. */
let historyAll = false;
/** Set when the person says they are recording a desktop call (Zoom, Teams, Slack) rather than Google Meet. */
let desktopChosen = false;
/** Why the last start did not begin; shown in place, since the popup has no other channel for it. */
let startError = "";
let startErrorRecovery: ErrorRecoveryCategory | undefined;
/** Revision guards keep delayed audio checks from overwriting newer helper state. */
let audioStatusRevision = 0;
let audioHelperConnected = false;
let desktopAudioReady = false;
/** The Meet tab this popup most recently detected as active, kept for the pending-start handoff. */
let lastActiveMeetTab: { id: number } | null = null;
const MEET_HOME = "https://meet.google.com/";

function onboardingUrl(): string {
  return getExtensionOnboardingUrl(chrome.runtime.getURL(""));
}

const DESKTOP_ONBOARDING_INTENT_KEY = "notetaker.desktopOnboardingIntentAt";

async function markDesktopOnboardingIntent(): Promise<void> {
  const session = chrome.storage.session;
  if (!session?.set) return;
  await new Promise<void>((resolve) => {
    try {
      session.set({ [DESKTOP_ONBOARDING_INTENT_KEY]: Date.now() }, () => resolve());
    } catch {
      resolve();
    }
  });
}

function clearLiveListener(): void {
  removeLiveListener?.();
  removeLiveListener = null;
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  quotaRefreshTimer = null;
}

function formatMeetingTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// A precise gear glyph at small sizes, unlike a raw emoji (which renders
// inconsistently across OS emoji fonts and reads soft at 16px).
const SETTINGS_ICON_SVG = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
`;

function renderHeader(showSettings: boolean): string {
  return `
    <header class="app-header">
      <div class="brand-lockup"><img src="../icons/icon48.png" alt="" aria-hidden="true" /><h1 tabindex="-1" data-view-heading>AI Notetaker</h1></div>
      ${showSettings ? `<button class="icon-button" id="open-settings" aria-label="Open settings">${SETTINGS_ICON_SVG}</button>` : ""}
    </header>
  `;
}

async function renderOnboardingPrompt(): Promise<void> {
  app.innerHTML = `
    ${renderHeader(false)}
    <div class="empty-state">
      <h2>Take notes on your calls, no bot</h2>
      <p>Setup takes about a minute: add your AI keys (or sign in to Hosted AI), allow the microphone, and you're ready for your next Google Meet.</p>
      <button class="primary" id="start-onboarding">Set up AI Notetaker</button>
    </div>
  `;
  document.getElementById("start-onboarding")?.addEventListener("click", () => {
    chrome.tabs.create({ url: onboardingUrl() });
  });
}

async function renderRecoverableBanner(recoverableMeeting: NonNullable<BackgroundState["recoverableMeeting"]>): Promise<void> {
  const container = document.createElement("div");
  container.className = "banner recoverable";
  container.innerHTML = `
    <p><strong>Unfinished recording found.</strong> A recording started ${escapeHtml(formatMeetingTime(recoverableMeeting.startedAt))} was interrupted. Resume it, or discard it.</p>
    <div class="banner-actions">
      <button class="primary" id="resume-recording">Resume</button>
      <button class="secondary" id="discard-recording">Discard</button>
    </div>
  `;
  app.prepend(container);
  document.getElementById("resume-recording")?.addEventListener("click", async () => {
    try {
      await sendToBackground({ type: "RESUME_RECORDING", meetingId: recoverableMeeting.meetingId });
      await render();
    } catch (error) {
      renderFailure(error);
    }
  });
  document.getElementById("discard-recording")?.addEventListener("click", async () => {
    try {
      await sendToBackground({ type: "DISCARD_RECORDING", meetingId: recoverableMeeting.meetingId });
      await render();
    } catch (error) {
      renderFailure(error);
    }
  });
}

function appendTranscriptLine(
  container: HTMLElement,
  speaker: Speaker,
  text: string,
  isFinal: boolean,
  utteranceId: number | undefined,
): void {
  const key = utteranceId === undefined ? null : `${speaker}:${utteranceId}`;
  const existing = key ? container.querySelector<HTMLElement>(`[data-utterance-key="${CSS.escape(key)}"]`) : null;
  const line = existing ?? document.createElement("div");
  line.className = isFinal ? "transcript-line" : "transcript-line transcript-line-provisional";
  line.innerHTML = `<span class="speaker">${escapeHtml(speakerLabel(speaker))}:</span>${escapeHtml(text)}`;
  if (key) {
    if (isFinal) {
      line.removeAttribute("data-utterance-key");
    } else {
      line.dataset.utteranceKey = key;
    }
  }
  if (!existing) container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

async function renderActiveRecording(meetingId: string, helperStatus: BackgroundState["helperStatus"], settings: Awaited<ReturnType<typeof getSettings>>): Promise<void> {
  const meeting = await getMeeting(meetingId);
  const liveCaptions = meeting?.captureSource === "meet"
    ? meeting.liveTranscriptStatus === "available" || meeting.liveTranscriptStatus === "connecting" || Boolean(meeting.transcript.length)
    : helperStatus === "connected";
  const recordingStatus = meeting?.captureSource === "meet" && meeting.liveTranscriptStatus === "connecting"
    ? "Connecting live captions…"
    : meeting?.captureSource === "meet" && meeting.liveTranscriptStatus === "unavailable"
      ? "Live captions are unavailable. Your saved audio will be processed after you stop."
      : liveCaptions ? "" : "Your transcript and notes are processed after you stop.";
  app.innerHTML = `
    ${renderHeader(true)}
    <div class="record-controls">
      <span class="recording-indicator">Recording</span>
      <button class="danger record-toggle" id="stop-recording">${STOP_LABEL}</button>
      ${modeChip(settings)}
    </div>
    <p id="recording-status" class="${meeting?.captureSource === "desktop" && helperStatus !== "connected" ? "text-warning" : "text-secondary"}" role="status" aria-live="polite"><span id="recording-status-message">${escapeHtml(meeting?.captureSource === "desktop" && helperStatus !== "connected" ? "Can't confirm the desktop helper connection. If the helper app closed, capture may have stopped. Check the helper before ending the call; audio already saved stays on this device." : recordingStatus)}</span>${meeting?.captureSource === "desktop" ? ` <button type="button" class="text-link" id="recording-helper-setup"${helperStatus === "connected" ? " hidden" : ""}>Open helper setup</button>` : ""}</p>
    ${meeting?.providerPreflightWarning ? `<p class="field-hint text-warning" role="alert">AI provider check: ${escapeHtml(meeting.providerPreflightWarning)}</p>` : ""}
    ${liveCaptions ? `<div class="transcript-view" id="transcript-view" role="log" aria-label="Live transcript"></div>` : ""}
  `;
  void refreshHostedQuota(settings);
  if (settings.processingMode.kind === "managed") {
    quotaRefreshTimer = setInterval(() => void refreshHostedQuota(settings), 60_000);
  }
  const transcriptView = document.getElementById("transcript-view");
  const pendingTranscriptUpdates: Extract<BackgroundToUiMessage, { type: "TRANSCRIPT_UPDATE" }>[] = [];
  const flushPendingTranscriptUpdates = async () => {
    const view = document.getElementById("transcript-view");
    if (!view) return;
    const queued = pendingTranscriptUpdates.splice(0);
    const meeting = await getMeeting(meetingId);
    const persistedFinals = new Set((meeting?.transcript ?? [])
      .filter((segment) => segment.isFinal && segment.utteranceId !== undefined)
      .map((segment) => `${segment.speaker}:${segment.utteranceId}`));
    for (const update of queued) {
      if (update.utteranceId !== undefined && persistedFinals.has(`${update.speaker}:${update.utteranceId}`)) continue;
      appendTranscriptLine(view, update.speaker, update.text, update.isFinal, update.utteranceId);
    }
  };
  if (transcriptView) {
    for (const segment of meeting?.transcript ?? []) {
      appendTranscriptLine(transcriptView, segment.speaker, segment.text, segment.isFinal, segment.utteranceId);
    }
  }
  const stopButton = document.getElementById("stop-recording") as HTMLButtonElement;
  const stopConfirm = createStopConfirm({
    arm: () => {
      stopButton.classList.add("armed");
      stopButton.setAttribute("aria-label", "Confirm: stop notes");
      stopButton.textContent = STOP_CONFIRM_LABEL;
    },
    disarm: () => {
      stopButton.classList.remove("armed");
      stopButton.removeAttribute("aria-label");
      stopButton.textContent = STOP_LABEL;
    },
    confirm: async () => {
      stopButton.disabled = true;
      try {
        await sendToBackground({ type: "STOP_RECORDING", meetingId });
        await render();
      } catch (error) {
        renderFailure(error);
      }
    },
  });
  stopButton.addEventListener("click", stopConfirm.press);
  document.getElementById("open-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("recording-helper-setup")?.addEventListener("click", async () => {
    await markDesktopOnboardingIntent();
    chrome.tabs.create({ url: getExtensionOnboardingUrl(chrome.runtime.getURL(""), "desktop") });
  });

  function liveListener(message: BackgroundToUiMessage): void {
    if (message.type === "HELPER_STATUS") {
      void refreshRecordingStatus(meetingId, message.status).then(flushPendingTranscriptUpdates);
      return;
    }
    if (message.type === "MEETING_STATE_CHANGED" && message.meetingId === meetingId) {
      void refreshRecordingStatus(meetingId, helperStatus).then(flushPendingTranscriptUpdates);
      void refreshIfNoLongerRecording(meetingId);
      return;
    }
    if (message.type === "TRANSCRIPT_UPDATE" && message.meetingId === meetingId) {
      const view = document.getElementById("transcript-view");
      if (view) appendTranscriptLine(view, message.speaker, message.text, message.isFinal, message.utteranceId);
      else pendingTranscriptUpdates.push(message);
    }
    // Notes finished, or the recording failed or was stopped elsewhere (the
    // in-call pill, the shortcut): leave this view instead of showing a
    // recording that is over. A failure while the popup is closed is covered
    // by the toolbar badge (see background.ts).
    if (
      (message.type === "SUMMARY_READY" && message.meetingId === meetingId) ||
      (message.type === "RECORDING_ERROR" && message.meetingId === meetingId) ||
      message.type === "MEETING_STATE_CHANGED"
    ) {
      void refreshIfNoLongerRecording(meetingId);
    }
    if (message.type === "PROCESSING_WARNING" && message.meetingId === meetingId) {
      const status = document.getElementById("recording-status");
      if (status) status.textContent = "A transcription chunk will be retried automatically.";
    }
  }
  chrome.runtime.onMessage.addListener(liveListener);
  removeLiveListener = () => chrome.runtime.onMessage.removeListener(liveListener);
}

async function refreshIfNoLongerRecording(meetingId: string): Promise<void> {
  try {
    const state = await sendToBackground<BackgroundState>({ type: "GET_STATE" });
    if (state.activeMeeting?.id === meetingId) return;
    clearLiveListener();
    await renderSafely();
  } catch {
    // The next render will pick the state up.
  }
}

async function refreshRecordingStatus(meetingId: string, helperStatus: BackgroundState["helperStatus"]): Promise<void> {
  const meeting = await getMeeting(meetingId);
  const status = document.getElementById("recording-status");
  const statusMessage = document.getElementById("recording-status-message");
  if (!meeting || !status || !statusMessage) return;
  const liveCaptions = meeting.captureSource === "meet"
    ? meeting.liveTranscriptStatus === "available" || meeting.liveTranscriptStatus === "connecting" || meeting.transcript.length > 0
    : helperStatus === "connected";
  const helperLost = meeting.captureSource === "desktop" && helperStatus !== "connected";
  status.className = helperLost ? "text-warning" : "text-secondary";
  statusMessage.textContent = helperLost
    ? "Can't confirm the desktop helper connection. If the helper app closed, capture may have stopped. Check the helper before ending the call; audio already saved stays on this device."
    : meeting.captureSource === "meet" && meeting.liveTranscriptStatus === "connecting"
    ? "Connecting live captions…"
    : meeting.captureSource === "meet" && meeting.liveTranscriptStatus === "unavailable"
      ? "Live captions are unavailable. Your saved audio will be processed after you stop."
      : liveCaptions ? "" : "Your transcript and notes are processed after you stop.";
  const setupButton = document.getElementById("recording-helper-setup") as HTMLButtonElement | null;
  if (setupButton) setupButton.hidden = !helperLost;
  if (liveCaptions && !document.getElementById("transcript-view")) {
    const transcriptView = document.createElement("div");
    transcriptView.id = "transcript-view";
    transcriptView.className = "transcript-view";
    transcriptView.setAttribute("role", "log");
    transcriptView.setAttribute("aria-label", "Live transcript");
    status.insertAdjacentElement("afterend", transcriptView);
    for (const segment of meeting.transcript) {
      appendTranscriptLine(transcriptView, segment.speaker, segment.text, segment.isFinal, segment.utteranceId);
    }
  }
}

function renderHistoryItem(meeting: MeetingRecord): string {
  const statusLabel =
    meeting.status === "processing"
      ? " · Processing…"
      : meeting.status === "error"
        ? " · Failed"
        : "";
  return `
    <button class="history-item" data-meeting-id="${escapeHtml(meeting.id)}">
      <span class="meeting-title">${escapeHtml(meeting.title)}</span>
      <span class="meeting-meta text-secondary">${formatMeetingTime(meeting.startedAt)}${statusLabel}</span>
    </button>
  `;
}

function meetingModeOptions(selected: MeetingMode): string {
  const options = [
    ["general", "General"],
    ["standup", "Standup"],
    ["sales", "Sales call"],
    ["one_on_one", "1:1"],
    ["interview", "Interview"],
    ["lecture", "Lecture"],
    ["custom", "Custom template"],
  ] as const;
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function desktopHelperStatusCopy(status: BackgroundState["helperStatus"]): string {
  if (status === "connected") return "Desktop helper connected. Desktop calls can be started from the toolbar.";
  if (status === "helper_not_found") return "Desktop helper is not registered with this browser. Install it, then check again.";
  if (status === "needs_pairing") return "Pair the helper with this browser from its tray menu, then check again.";
  if (status === "incompatible") return "This desktop helper needs an update. Install the current version from desktop setup.";
  if (status === "permission_required") return "Allow Native Messaging from desktop setup so the extension can reach the helper.";
  if (status === "connecting") return "Connecting to the desktop helper…";
  return "Can't reach the desktop helper. Make sure AI Notetaker is open, then check again.";
}

/** Desktop calls only: the helper's view of the microphone and meeting audio. */
async function renderAudioStatus(helperStatus: BackgroundState["helperStatus"]): Promise<void> {
  const revision = ++audioStatusRevision;
  const statusEl = document.getElementById("audio-status");
  const checkButton = document.getElementById("check-audio") as HTMLButtonElement | null;
  const probeButton = document.getElementById("test-audio") as HTMLButtonElement | null;
  const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
  if (!statusEl) return;
  audioHelperConnected = helperStatus === "connected";
  desktopAudioReady = false;
  if (helperStatus !== "connected") {
    statusEl.textContent = desktopHelperStatusCopy(helperStatus);
    statusEl.className = "text-warning";
    if (checkButton) checkButton.disabled = true;
    if (probeButton) probeButton.disabled = true;
    if (startButton) startButton.disabled = true;
    return;
  }
  statusEl.textContent = "Checking audio devices…";
  statusEl.className = "text-secondary";
  if (checkButton) checkButton.disabled = true;
  if (probeButton) probeButton.disabled = true;
  if (startButton) startButton.disabled = true;
  try {
    const response = await sendToBackground<{ status: AudioStatus }>({ type: "GET_AUDIO_PREFLIGHT" });
    if (revision !== audioStatusRevision) return;
    const status = response.status;
    desktopAudioReady = status.ready;
    const deviceLine = [status.microphone ? `Mic: ${status.microphone}` : "Mic: missing", status.speaker ? `Meeting audio: ${status.speaker}` : "Meeting audio: missing"].join(" · ");
    const capturePath = status.nativeLoopback ? "Native system-audio capture." : status.virtualDeviceFallback ? "Virtual-device fallback active." : "System-audio capture unavailable.";
    const readiness = !status.driverInstalled
      ? "Audio driver missing."
      : status.ready
        ? "Audio ready."
        : "Audio routing incomplete.";
    statusEl.textContent = `${readiness} ${deviceLine} ${capturePath} ${status.guidance}`;
    statusEl.className = status.ready ? "text-success" : "text-warning";
    if (checkButton) checkButton.textContent = status.ready ? "Refresh audio check" : "Check audio again";
    if (probeButton) probeButton.disabled = !status.ready;
    if (startButton) startButton.disabled = !status.ready;
  } catch {
    if (revision !== audioStatusRevision) return;
    statusEl.textContent = "Audio check failed. Confirm the desktop helper is running, then try again.";
    statusEl.className = "text-warning";
    if (probeButton) probeButton.disabled = true;
    if (startButton) startButton.disabled = true;
  } finally {
    if (revision === audioStatusRevision && checkButton) checkButton.disabled = !audioHelperConnected;
  }
}

async function runAudioProbe(): Promise<void> {
  const statusEl = document.getElementById("audio-status");
  const probeButton = document.getElementById("test-audio") as HTMLButtonElement | null;
  if (!statusEl) return;
  if (!audioHelperConnected || !desktopAudioReady || probeButton?.disabled) return;
  const revision = audioStatusRevision;
  if (probeButton) probeButton.disabled = true;
  statusEl.textContent = "Listening for microphone and meeting audio for 2 seconds…";
  try {
    const response = await sendToBackground<{ result: AudioProbeResult }>({ type: "RUN_AUDIO_PROBE" });
    if (revision !== audioStatusRevision || !audioHelperConnected) return;
    statusEl.textContent = response.result.message;
    statusEl.className = response.result.passed ? "text-success" : "text-warning";
  } catch {
    if (revision !== audioStatusRevision || !audioHelperConnected) return;
    statusEl.textContent = "Audio test failed. Confirm the desktop helper is running, then try again.";
    statusEl.className = "text-warning";
  } finally {
    if (probeButton && revision === audioStatusRevision) probeButton.disabled = !audioHelperConnected || !desktopAudioReady;
  }
}

async function activeMeetTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return isMeetUrl(tab?.url) ? tab : undefined;
  } catch {
    return undefined;
  }
}

function modeChip(settings: Awaited<ReturnType<typeof getSettings>>): string {
  const hosted = settings.processingMode.kind === "managed";
  const providerLabels: Record<string, string> = {
    deepgram: "Deepgram",
    groq: "Groq",
    claude: "Claude",
    gemini: "Gemini",
    deepseek: "DeepSeek",
  };
  const label = hosted
    ? "Using Hosted AI"
    : `Using ${providerLabels[settings.transcriptionProvider] ?? "your transcription provider"} + ${providerLabels[settings.summarizationProvider] ?? "your summary provider"}`;
  const detail = hosted
    ? "Counts against your Hosted AI plan allowance."
    : "Your providers may bill you directly; Hosted AI allowance is not used.";
  const quota = hosted ? `<span class="mode-chip-quota" id="hosted-quota" role="status" aria-live="polite">Checking plan allowance…</span>` : "";
  return `<div class="mode-chip${hosted ? " mode-chip--hosted" : ""}" id="mode-chip"><strong>${label}</strong><span>${detail}</span>${quota}</div>`;
}

async function refreshHostedQuota(settings: Awaited<ReturnType<typeof getSettings>>): Promise<void> {
  if (settings.processingMode.kind !== "managed" || !settings.managedService) return;
  const quota = document.getElementById("hosted-quota");
  if (!quota) return;
  try {
    const entitlements = await sendToBackground<import("../lib/internalMessages").ManagedEntitlementsResponse>({ type: "GET_MANAGED_ENTITLEMENTS" });
    if (!entitlements || !document.getElementById("hosted-quota")) return;
    const hours = Math.floor(entitlements.audio.remainingSeconds / 3600);
    const minutes = Math.floor((entitlements.audio.remainingSeconds % 3600) / 60);
    const audioRemaining = entitlements.audio.remainingSeconds < 60
      ? `${entitlements.audio.remainingSeconds}s audio`
      : hours > 0 ? `${hours}h ${minutes}m audio` : `${minutes}m audio`;
    quota.textContent = `${entitlements.remaining} ${entitlements.remaining === 1 ? "meeting" : "meetings"} and ${audioRemaining} left this period.`;
    const low = entitlements.warning === "low" || entitlements.audio.warning === "low";
    const exhausted = entitlements.warning === "exhausted" || entitlements.audio.warning === "exhausted" || !entitlements.canProcess;
    const chip = document.getElementById("mode-chip");
    chip?.classList.remove("mode-chip--warning", "mode-chip--low");
    chip?.querySelectorAll(".mode-chip-notice, .mode-chip-actions").forEach((node) => node.remove());
    if (low || exhausted) {
      chip?.classList.add(exhausted ? "mode-chip--warning" : "mode-chip--low");
      const help = document.createElement("span");
      help.className = "mode-chip-notice";
      help.textContent = exhausted
        ? "Hosted processing is unavailable. Saved recordings never switch providers automatically."
        : "Hosted allowance is running low. Check your plan; allowance is checked again when notes are processed.";
      const actions = document.createElement("span");
      actions.className = "mode-chip-actions";
      const billing = document.createElement("a");
      billing.href = managedBillingUrl(settings.managedService!.baseUrl);
      billing.target = "_blank";
      billing.rel = "noreferrer";
      billing.textContent = "View plan";
      actions.append(billing);
      if (exhausted) {
        const switchButton = document.createElement("button");
        switchButton.type = "button";
        switchButton.className = "text-link";
        switchButton.textContent = "Switch to my API keys";
        switchButton.addEventListener("click", () => void sendToBackground({ type: "OPEN_PAGE", page: "settings" }));
        actions.append(switchButton);
      }
      chip?.append(help, actions);
    }
  } catch {
    const current = document.getElementById("hosted-quota");
    if (current) current.textContent = "Could not check Hosted AI allowance. It will be checked again before recording.";
  }
}

/**
 * A remembered widget start is only honored when the popup opened on that
 * same Meet tab while nothing is recording. A different tab (the person moved
 * on), a live recording (someone started elsewhere — the shortcut), or a
 * stale session entry must never trigger an auto-start.
 */
function isPendingStartCurrent(intent: { tabId: number }, state: BackgroundState): boolean {
  if (state.activeMeeting) return false;
  const tab = lastActiveMeetTab;
  return tab?.id === intent.tabId;
}

async function resumePendingStart(intent: { tabId: number; meetingMode?: string; titleHint?: string }): Promise<void> {
  try {
    const response = await sendToBackground<{ meetingId?: string }>({
      type: "START_RECORDING",
      captureSource: "meet",
      meetingMode: (intent.meetingMode ?? "general") as MeetingMode,
      tabId: intent.tabId,
      ...(intent.titleHint ? { titleHint: intent.titleHint } : {}),
    });
    if (!response?.meetingId) return;
    await renderSafely();
  } catch {
    // The auto-start is a convenience; the popup's Start button remains.
  }
}

/** The popup's idle view knows where the person is: on a Meet call, it is one button. */
async function renderIdleState(initialHelperStatus: BackgroundState["helperStatus"], settings: Awaited<ReturnType<typeof getSettings>>): Promise<void> {
  let helperStatus = initialHelperStatus;
  const meetings = await listMeetings(historyQuery || historyAll ? undefined : HISTORY_RECENT_COUNT, historyQuery || undefined);
  const meetTab = await activeMeetTab();
  lastActiveMeetTab = meetTab && typeof meetTab.id === "number" ? { id: meetTab.id } : null;
  const onMeet = meetTab !== undefined;
  const desktop = !onMeet && (desktopChosen || helperStatus === "connected");
  const helperReady = helperStatus === "connected";
  const autoRecordGuidance = settings.autoRecordOnMeetJoin
    ? onMeet
      ? "Auto-record on join is on. If Chrome blocks the first start, one toolbar click starts it—no second Start notes step."
      : "Auto-record on join is on. Join a Google Meet call to start notes automatically; if Chrome blocks the first start, click AI Notetaker once on the call tab."
    : "Auto-record on join is off. Start notes from the call widget or toolbar, or enable auto-record in Settings.";
  const controls = onMeet || desktop
    ? `
      <button class="primary record-toggle" id="start-recording"${desktop ? " disabled" : ""}>Start notes</button>
      ${modeChip(settings)}
      ${onMeet ? `<p id="meet-auto-record-guidance" class="field-hint text-secondary">${autoRecordGuidance}</p>` : ""}
      <label class="meeting-mode-picker" for="meeting-mode">Notes style
        <select id="meeting-mode">${meetingModeOptions(settings.defaultMeetingMode)}</select>
      </label>
      <p id="start-error" class="start-error" role="alert"${startError ? "" : " hidden"}>${escapeHtml(startError)}</p>
      ${onMeet ? `<div class="audio-check-actions" id="provider-preflight-actions"${startErrorRecovery === "provider_preflight" ? "" : " hidden"}><button type="button" class="secondary" id="open-provider-settings">Open AI settings</button><button type="button" class="primary" id="continue-provider-warning">Record anyway</button></div>` : ""}
      ${
        desktop
          ? `<div class="audio-check" aria-live="polite">
        <p id="audio-status" class="text-secondary">Checking audio devices…</p>
        <div class="audio-check-actions">
          <button type="button" class="secondary" id="check-audio">Check audio</button>
          <button type="button" class="secondary" id="test-audio" disabled>Run 2-second test</button>
        </div>
      </div>
      <div class="audio-check" id="desktop-helper-actions">
        <p class="field-hint text-secondary" id="desktop-helper-status" role="status" aria-live="polite">${escapeHtml(desktopHelperStatusCopy(helperStatus))}</p>
        <button type="button" class="secondary" id="open-helper-setup"${helperReady ? " hidden" : ""}>Set up desktop capture</button>
        <button type="button" class="text-link" id="use-meet">Recording Google Meet instead?</button>
      </div>`
          : ""
      }`
    : `
      <button class="primary record-toggle" id="open-meet">Open Google Meet</button>
      ${modeChip(settings)}
      <p id="start-error" class="start-error" role="alert"${startError ? "" : " hidden"}>${escapeHtml(startError)}</p>
      <p id="meet-auto-record-guidance" class="field-hint text-secondary">${autoRecordGuidance}</p>
      <button type="button" class="text-link" id="use-desktop">Recording Zoom or Teams instead?</button>`;
  app.innerHTML = `
    ${renderHeader(true)}
    <div class="record-controls">${controls}</div>
    <div class="history-section">
      <div class="history-heading">
        <h2 tabindex="-1" data-view-heading id="history-title"></h2>
        <button type="button" class="text-link" id="open-action-inbox">Actions</button>
      </div>
      <form class="meeting-search" id="meeting-search" role="search">
        <label class="sr-only" for="meeting-search-input">Search meetings</label>
        <input id="meeting-search-input" type="search" maxlength="200" placeholder="Search all meetings…" value="${escapeHtml(historyQuery)}" autocomplete="off" />
        <button type="button" class="text-link" id="clear-meeting-search"${historyQuery ? "" : " hidden"}>Clear</button>
      </form>
      <p class="field-hint text-secondary" id="history-summary" role="status" aria-live="polite"></p>
      <div id="history-results"></div>
      <button type="button" class="secondary history-more" id="history-more" hidden></button>
    </div>
  `;
  void refreshHostedQuota(settings);

  let results = meetings;
  let shown = HISTORY_PAGE_SIZE;
  let searchSeq = 0;
  const searchInput = document.getElementById("meeting-search-input") as HTMLInputElement;

  function paintHistory(): void {
    const { visible, remaining } = pageOf(results, shown);
    document.getElementById("history-title")!.textContent = historyHeading(historyQuery, historyAll);
    document.getElementById("history-summary")!.textContent = resultsSummary(results.length, historyQuery);
    document.getElementById("clear-meeting-search")!.hidden = !historyQuery;
    document.getElementById("history-results")!.innerHTML = visible.length
      ? visible.map(renderHistoryItem).join("")
      : `<p class="empty-state">${historyQuery ? `No meetings match “${escapeHtml(historyQuery)}”.` : "No meetings yet. Your notes will show up here."}</p>`;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".history-item")) {
      button.addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(button.dataset.meetingId!)}`) });
      });
    }
    const more = document.getElementById("history-more") as HTMLButtonElement;
    // Without a search or browse-all, the list is just the newest few; offer the rest in one click.
    const canBrowse = !historyQuery && !historyAll && results.length >= HISTORY_RECENT_COUNT;
    more.hidden = remaining === 0 && !canBrowse;
    more.textContent = remaining > 0 ? `Show ${Math.min(remaining, HISTORY_PAGE_SIZE)} more` : "Browse all meetings";
  }

  /** Re-query without re-rendering the page, so typing keeps focus; stale answers are dropped. */
  async function refreshHistory(): Promise<void> {
    const seq = ++searchSeq;
    const list = await listMeetings(historyQuery || historyAll ? undefined : HISTORY_RECENT_COUNT, historyQuery || undefined);
    if (seq !== searchSeq) return;
    results = list;
    shown = HISTORY_PAGE_SIZE;
    paintHistory();
  }
  paintHistory();

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      historyQuery = searchInput.value.trim();
      void refreshHistory();
    }, SEARCH_DEBOUNCE_MS);
  });
  document.getElementById("history-more")?.addEventListener("click", () => {
    if (results.length > shown) {
      const firstNew = shown;
      shown += HISTORY_PAGE_SIZE;
      paintHistory();
      // Keep a keyboard user's place: land on the first newly revealed row.
      document.querySelectorAll<HTMLButtonElement>(".history-item")[firstNew]?.focus();
    } else {
      historyAll = true;
      void refreshHistory();
    }
  });
  document.getElementById("meeting-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(searchTimer);
    historyQuery = searchInput.value.trim();
    void refreshHistory();
  });
  document.getElementById("clear-meeting-search")?.addEventListener("click", () => {
    searchInput.value = "";
    historyQuery = "";
    void refreshHistory();
    searchInput.focus();
  });

  // A start that never began is reported by the background as a broadcast, and
  // only this idle view can show it.
  function idleListener(message: BackgroundToUiMessage): void {
    if (message.type === "HELPER_STATUS") {
      if (desktop) {
        // Ignore the intermediate retry state. The last confirmed condition
        // remains stable until the helper actually connects or disconnects.
        if (message.status !== "connecting" || helperStatus === "connecting") {
          helperStatus = message.status;
          const helperLine = document.getElementById("desktop-helper-status");
          if (helperLine) helperLine.textContent = desktopHelperStatusCopy(helperStatus);
          const setupButton = document.getElementById("open-helper-setup") as HTMLButtonElement | null;
          if (setupButton) setupButton.hidden = helperStatus === "connected";
          void renderAudioStatus(helperStatus);
        }
      }
      return;
    }
    if (message.type !== "RECORDING_ERROR" || (message.meetingId !== null && message.phase !== "start")) return;
    startError = message.message;
    startErrorRecovery = message.recovery;
    const el = document.getElementById("start-error");
    if (el) {
      el.textContent = startError;
      el.hidden = false;
    }
    const recoveryActions = document.getElementById("provider-preflight-actions");
    if (recoveryActions) recoveryActions.hidden = startErrorRecovery !== "provider_preflight";
    const button = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (button && onMeet) button.disabled = false;
  }
  chrome.runtime.onMessage.addListener(idleListener);
  removeLiveListener = () => chrome.runtime.onMessage.removeListener(idleListener);

  const startFromPopup = async (allowProviderWarning = false): Promise<void> => {
    const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (startButton) startButton.disabled = true;
    startError = "";
    startErrorRecovery = undefined;
    const recoveryActions = document.getElementById("provider-preflight-actions");
    if (recoveryActions) recoveryActions.hidden = true;
    const errorEl = document.getElementById("start-error");
    if (errorEl) errorEl.hidden = true;
    try {
      if (onMeet && settings.processingMode.kind === "local_byok") {
        const providers = [settings.transcriptionProvider, settings.summarizationProvider]
          .filter((provider, index, all) => Boolean(settings.apiKeys[provider]?.trim()) && all.indexOf(provider) === index);
        if (providers.length > 0 && !(await requestOptionalPermission(providerHostPermissions(providers)))) {
          startError = "Chrome provider access was not granted. Your call was not started. Allow the selected AI provider sites in Settings, then try again.";
          if (errorEl) {
            errorEl.textContent = startError;
            errorEl.hidden = false;
          }
          if (startButton) startButton.disabled = false;
          return;
        }
      }
      const meetingMode = (document.getElementById("meeting-mode") as HTMLSelectElement).value as MeetingMode;
      const titleHint = meetTitleForTab(meetTab);
      await sendToBackground({
        type: "START_RECORDING",
        meetingMode,
        captureSource: onMeet ? "meet" : "desktop",
        ...(allowProviderWarning ? { allowProviderWarning: true } : {}),
        ...(onMeet && typeof meetTab?.id === "number" ? { tabId: meetTab.id } : {}),
        ...(titleHint ? { titleHint } : {}),
      });
      await renderSafely();
    } catch (error) {
      startError = "Could not start notes. Check the required permissions and helper connection, then try again.";
      startErrorRecovery = undefined;
      if (errorEl) {
        errorEl.textContent = startError;
        errorEl.hidden = false;
      }
      if (startButton) startButton.disabled = false;
      console.warn("Could not start recording", error);
    }
  };
  document.getElementById("start-recording")?.addEventListener("click", () => void startFromPopup());
  document.getElementById("continue-provider-warning")?.addEventListener("click", () => void startFromPopup(true));
  document.getElementById("open-provider-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("open-meet")?.addEventListener("click", () => {
    chrome.tabs.create({ url: MEET_HOME });
    window.close();
  });
  document.getElementById("use-desktop")?.addEventListener("click", () => {
    desktopChosen = true;
    startError = "";
    startErrorRecovery = undefined;
    void renderSafely();
  });
  document.getElementById("use-meet")?.addEventListener("click", () => {
    desktopChosen = false;
    startError = "";
    startErrorRecovery = undefined;
    chrome.tabs.create({ url: MEET_HOME });
    window.close();
  });
  document.getElementById("check-audio")?.addEventListener("click", () => void renderAudioStatus(helperStatus));
  document.getElementById("test-audio")?.addEventListener("click", () => void runAudioProbe());
  document.getElementById("open-helper-setup")?.addEventListener("click", async () => {
    // This is an explicit desktop choice. Keep the ordinary popup entry point
    // Meet-first, but preserve the user's deliberate request for helper setup.
    await markDesktopOnboardingIntent();
    chrome.tabs.create({ url: getExtensionOnboardingUrl(chrome.runtime.getURL(""), "desktop") });
  });
  document.getElementById("open-action-inbox")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("actions/actions.html") });
  });
  document.getElementById("open-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  if (desktop) void renderAudioStatus(helperStatus);
}

async function render(): Promise<void> {
  clearLiveListener();
  const settings = await getSettings();
  if (!settings.onboardingComplete) {
    await renderOnboardingPrompt();
    return;
  }

  const state = await sendToBackground<BackgroundState>({ type: "GET_STATE" });

  if (state.activeMeeting?.starting) {
    app.innerHTML = `${renderHeader(true)}<div class="empty-state" role="status"><h2 data-view-heading tabindex="-1">Connecting to the call audio…</h2><p>Recording will begin when the audio connection is ready.</p></div>`;
    const listener = (message: BackgroundToUiMessage) => {
      if (message.type === "MEETING_STATE_CHANGED" || message.type === "RECORDING_ERROR") void renderSafely();
    };
    chrome.runtime.onMessage.addListener(listener);
    removeLiveListener = () => chrome.runtime.onMessage.removeListener(listener);
    document.getElementById("open-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  } else if (state.activeMeeting) {
    await renderActiveRecording(state.activeMeeting.id, state.helperStatus, settings);
  } else {
    await renderIdleState(state.helperStatus, settings);
    // Chrome just granted this popup's click as the tab invocation — the one
    // thing the in-call widget's click can never be. If the widget's start was
    // blocked waiting for exactly this moment, finish what it started now,
    // on this same click, instead of showing the person a Start button they
    // already pressed once.
    const intent = await takePendingMeetStart();
    if (intent && isPendingStartCurrent(intent, state)) {
      void resumePendingStart(intent);
    }
  }

  if (state.recoverableMeeting) {
    await renderRecoverableBanner(state.recoverableMeeting);
  }

  // Each render replaces the entire view. Move focus to the new view's
  // heading instead of leaving keyboard users at document.body.
  app.querySelector<HTMLElement>("[data-view-heading]")?.focus({ preventScroll: true });
}

function renderFailure(error: unknown): void {
  console.error("AI Notetaker popup failed to render", error);
  clearLiveListener();
  app.innerHTML = `
    ${renderHeader(true)}
    <div class="empty-state error-state" role="alert">
      <p>Something went wrong loading AI Notetaker.</p>
      <button type="button" class="primary" id="retry-render">Try again</button>
    </div>
  `;
  document.getElementById("retry-render")?.addEventListener("click", () => void renderSafely());
  document.getElementById("open-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

async function renderSafely(): Promise<void> {
  try {
    await render();
  } catch (error) {
    renderFailure(error);
  }
}

void renderSafely();
