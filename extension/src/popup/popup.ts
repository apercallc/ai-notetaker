import { getMeeting, getSettings, listMeetings } from "../lib/storage";
import { createStopConfirm, STOP_CONFIRM_LABEL, STOP_LABEL } from "../lib/stopConfirm";
import type { BackgroundState, BackgroundToUiMessage } from "../lib/internalMessages";
import { speakerLabel, type AudioProbeResult, type AudioStatus, type MeetingMode, type MeetingRecord, type Speaker } from "../types";
import { escapeHtml } from "../lib/html";
import { getExtensionOnboardingUrl } from "../lib/install";
import { isMeetUrl, meetTitleForTab } from "../meet/meetContext";
import { takePendingMeetStart } from "../meet/pendingStart";

const app = document.getElementById("app")!;
let removeLiveListener: (() => void) | null = null;
let historyQuery = "";
/** Set when the person says they are recording a desktop call (Zoom, Teams, Slack) rather than Google Meet. */
let desktopChosen = false;
/** Why the last start did not begin; shown in place, since the popup has no other channel for it. */
let startError = "";
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
}

async function sendToBackground<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
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
      <h1 tabindex="-1" data-view-heading>AI Notetaker</h1>
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
      <button class="primary" id="start-onboarding">Set up Notetaker</button>
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

async function renderActiveRecording(meetingId: string, helperStatus: BackgroundState["helperStatus"]): Promise<void> {
  const meeting = await getMeeting(meetingId);
  // Live captions come from the desktop helper; a browser-only recording is
  // written up when it stops.
  const liveCaptions = helperStatus === "connected";
  app.innerHTML = `
    ${renderHeader(true)}
    <div class="record-controls">
      <span class="recording-indicator">Recording</span>
      <button class="danger record-toggle" id="stop-recording">${STOP_LABEL}</button>
    </div>
    <p id="recording-status" class="text-secondary" role="status" aria-live="polite">${liveCaptions ? "" : "Your notes are written when you stop. Live captions need the desktop helper."}</p>
    ${liveCaptions ? `<div class="transcript-view" id="transcript-view" role="log" aria-label="Live transcript"></div>` : ""}
  `;
  const transcriptView = document.getElementById("transcript-view");
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

  function liveListener(message: BackgroundToUiMessage): void {
    if (message.type === "TRANSCRIPT_UPDATE" && message.meetingId === meetingId && transcriptView) {
      appendTranscriptLine(transcriptView, message.speaker, message.text, message.isFinal, message.utteranceId);
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
    ["custom", "Custom template"],
  ] as const;
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

/** Desktop calls only: the helper's view of the microphone and meeting audio. */
async function renderAudioStatus(helperStatus: BackgroundState["helperStatus"]): Promise<void> {
  const statusEl = document.getElementById("audio-status");
  const checkButton = document.getElementById("check-audio") as HTMLButtonElement | null;
  const probeButton = document.getElementById("test-audio") as HTMLButtonElement | null;
  const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
  if (!statusEl) return;
  if (helperStatus !== "connected") {
    statusEl.textContent = helperStatus === "incompatible"
      ? "The desktop helper needs an update. Open desktop setup to install the current version."
      : helperStatus === "needs_pairing"
        ? "The helper is paired with a different browser. Open the helper's tray menu and choose 'Pair New Browser', then try again."
        : "The desktop helper is not running. Open desktop setup to install it, then launch it.";
    statusEl.className = "text-warning";
    if (checkButton) checkButton.disabled = true;
    if (probeButton) probeButton.disabled = true;
    if (startButton) startButton.disabled = true;
    return;
  }
  statusEl.textContent = "Checking audio devices…";
  statusEl.className = "text-secondary";
  if (checkButton) checkButton.disabled = false;
  try {
    const response = await sendToBackground<{ status: AudioStatus }>({ type: "GET_AUDIO_PREFLIGHT" });
    const status = response.status;
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
    statusEl.textContent = "Audio check failed. Confirm the desktop helper is running, then try again.";
    statusEl.className = "text-warning";
    if (probeButton) probeButton.disabled = true;
    if (startButton) startButton.disabled = false;
  }
}

async function runAudioProbe(): Promise<void> {
  const statusEl = document.getElementById("audio-status");
  const probeButton = document.getElementById("test-audio") as HTMLButtonElement | null;
  if (!statusEl) return;
  if (probeButton) probeButton.disabled = true;
  statusEl.textContent = "Listening for microphone and meeting audio for 2 seconds…";
  try {
    const response = await sendToBackground<{ result: AudioProbeResult }>({ type: "RUN_AUDIO_PROBE" });
    statusEl.textContent = response.result.message;
    statusEl.className = response.result.passed ? "text-success" : "text-warning";
  } catch {
    statusEl.textContent = "Audio test failed. Confirm the desktop helper is running, then try again.";
    statusEl.className = "text-warning";
  } finally {
    if (probeButton) probeButton.disabled = false;
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
  const label = settings.processingMode.kind === "managed" ? "Hosted AI" : "Your own API keys";
  return `<p class="mode-chip" id="mode-chip"><span class="sr-only">Notes are written with: </span>${label}</p>`;
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
async function renderIdleState(helperStatus: BackgroundState["helperStatus"], settings: Awaited<ReturnType<typeof getSettings>>): Promise<void> {
  const meetings = await listMeetings(historyQuery ? undefined : 5, historyQuery || undefined);
  const meetTab = await activeMeetTab();
  lastActiveMeetTab = meetTab && typeof meetTab.id === "number" ? { id: meetTab.id } : null;
  const onMeet = meetTab !== undefined;
  const desktop = !onMeet && (desktopChosen || helperStatus === "connected");
  const helperReady = helperStatus === "connected";
  const autoRecordGuidance = settings.autoRecordOnMeetJoin
    ? onMeet
      ? "Auto-record on join is on. If Chrome blocks the first start, one toolbar click starts it—no second Start notes step."
      : "Auto-record on join is on. Join a Google Meet call to start notes automatically; if Chrome blocks the first start, click Notetaker once on the call tab."
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
        <p class="field-hint text-secondary">${helperReady ? "Recording a desktop call (Zoom, Teams, Slack)." : "Desktop calls need the native helper. Google Meet does not."}</p>
        ${helperReady ? "" : `<button type="button" class="secondary" id="open-helper-setup">Set up desktop capture</button>`}
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
        <h2 tabindex="-1" data-view-heading>${historyQuery ? "Search results" : "Recent meetings"}</h2>
        <button type="button" class="text-link" id="open-action-inbox">Action inbox</button>
      </div>
      <form class="meeting-search" id="meeting-search" role="search">
        <label class="sr-only" for="meeting-search-input">Search meetings</label>
        <input id="meeting-search-input" type="search" maxlength="200" placeholder="Search all meetings…" value="${escapeHtml(historyQuery)}" />
        <button type="submit" class="secondary">Search</button>
        ${historyQuery ? `<button type="button" class="text-link" id="clear-meeting-search">Clear</button>` : ""}
      </form>
      ${
        meetings.length > 0
          ? meetings.map(renderHistoryItem).join("")
          : `<p class="empty-state">${historyQuery ? `No meetings match “${escapeHtml(historyQuery)}”.` : "No meetings yet. Your notes will show up here."}</p>`
      }
    </div>
  `;

  // A start that never began is reported by the background as a broadcast, and
  // only this idle view can show it.
  function idleListener(message: BackgroundToUiMessage): void {
    if (message.type !== "RECORDING_ERROR" || (message.meetingId !== null && message.phase !== "start")) return;
    startError = message.message;
    const el = document.getElementById("start-error");
    if (el) {
      el.textContent = startError;
      el.hidden = false;
    }
    const button = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (button && onMeet) button.disabled = false;
  }
  chrome.runtime.onMessage.addListener(idleListener);
  removeLiveListener = () => chrome.runtime.onMessage.removeListener(idleListener);

  document.getElementById("start-recording")?.addEventListener("click", async () => {
    const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (startButton) startButton.disabled = true;
    startError = "";
    const errorEl = document.getElementById("start-error");
    if (errorEl) errorEl.hidden = true;
    try {
      const meetingMode = (document.getElementById("meeting-mode") as HTMLSelectElement).value as MeetingMode;
      const titleHint = meetTitleForTab(meetTab);
      await sendToBackground({
        type: "START_RECORDING",
        meetingMode,
        captureSource: onMeet ? "meet" : "desktop",
        ...(onMeet && typeof meetTab?.id === "number" ? { tabId: meetTab.id } : {}),
        ...(titleHint ? { titleHint } : {}),
      });
      await renderSafely();
    } catch (error) {
      renderFailure(error);
    }
  });
  document.getElementById("open-meet")?.addEventListener("click", () => {
    chrome.tabs.create({ url: MEET_HOME });
    window.close();
  });
  document.getElementById("use-desktop")?.addEventListener("click", () => {
    desktopChosen = true;
    startError = "";
    void renderSafely();
  });
  document.getElementById("use-meet")?.addEventListener("click", () => {
    desktopChosen = false;
    startError = "";
    void renderSafely();
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
  document.getElementById("meeting-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    historyQuery = (document.getElementById("meeting-search-input") as HTMLInputElement).value.trim();
    void renderSafely();
  });
  document.getElementById("clear-meeting-search")?.addEventListener("click", () => {
    historyQuery = "";
    void renderSafely();
  });
  document.getElementById("open-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  for (const button of document.querySelectorAll<HTMLButtonElement>(".history-item")) {
    button.addEventListener("click", () => {
      const id = button.dataset.meetingId!;
      chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(id)}`) });
    });
  }
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

  if (state.activeMeeting) {
    await renderActiveRecording(state.activeMeeting.id, state.helperStatus);
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
      <p>Something went wrong loading the notetaker.</p>
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
