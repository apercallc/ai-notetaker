import { getMeeting, getSettings, listMeetings } from "../lib/storage";
import type { BackgroundState, BackgroundToUiMessage } from "../lib/internalMessages";
import { speakerLabel, type AudioProbeResult, type AudioStatus, type MeetingMode, type MeetingRecord, type Speaker } from "../types";
import { escapeHtml } from "../lib/html";
import { getInstallPageUrl } from "../lib/install";

const app = document.getElementById("app")!;
let removeLiveListener: (() => void) | null = null;
let historyQuery = "";

function clearLiveListener(): void {
  removeLiveListener?.();
  removeLiveListener = null;
}

async function sendToBackground<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
      <p>Let's get you set up — pick a virtual audio device, add your API key, and you're recording.</p>
      <button class="primary" id="start-onboarding">Start setup</button>
    </div>
  `;
  document.getElementById("start-onboarding")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  });
}

async function renderRecoverableBanner(recoverableMeeting: NonNullable<BackgroundState["recoverableMeeting"]>): Promise<void> {
  const container = document.createElement("div");
  container.className = "banner recoverable";
  container.innerHTML = `
    <p><strong>Unfinished recording found.</strong> It looks like the helper was interrupted while recording a meeting started ${formatRelativeDate(recoverableMeeting.startedAt)}.</p>
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

function renderHelperMissingBanner(status: BackgroundState["helperStatus"], helperInfo: BackgroundState["helperInfo"]): void {
  const container = document.createElement("div");
  container.className = "banner missing-helper";
  const incompatible = status === "incompatible";
  container.innerHTML = `
    <p><strong>${incompatible ? "Helper update required." : "Helper not detected."}</strong> ${incompatible ? `Version ${escapeHtml(helperInfo?.helperVersion ?? "unknown")} is not compatible with this extension.` : "Recording needs the AI Notetaker desktop helper installed and running."}</p>
    <button class="secondary" id="open-helper-setup">${incompatible ? "Update desktop helper" : "Install desktop helper"}</button>
  `;
  app.prepend(container);
  document.getElementById("open-helper-setup")?.addEventListener("click", () => {
    chrome.tabs.create({ url: getInstallPageUrl("popup") });
  });
}

function appendTranscriptLine(container: HTMLElement, speaker: Speaker, text: string): void {
  const line = document.createElement("div");
  line.className = "transcript-line";
  line.innerHTML = `<span class="speaker">${escapeHtml(speakerLabel(speaker))}:</span>${escapeHtml(text)}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

async function renderActiveRecording(meetingId: string): Promise<void> {
  const meeting = await getMeeting(meetingId);
  app.innerHTML = `
    ${renderHeader(true)}
    <div class="record-controls">
      <span class="recording-indicator">Recording</span>
      <button class="danger record-toggle" id="stop-recording">Stop</button>
    </div>
    <p id="status" class="text-secondary" role="status" aria-live="polite"></p>
    <div class="transcript-view" id="transcript-view" role="log" aria-label="Live transcript"></div>
  `;
  const transcriptView = document.getElementById("transcript-view")!;
  for (const segment of meeting?.transcript ?? []) {
    appendTranscriptLine(transcriptView, segment.speaker, segment.text);
  }
  document.getElementById("stop-recording")?.addEventListener("click", async () => {
    try {
      await sendToBackground({ type: "STOP_RECORDING", meetingId });
      await render();
    } catch (error) {
      renderFailure(error);
    }
  });
  document.getElementById("open-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());

  function liveListener(message: BackgroundToUiMessage): void {
    if (message.type === "TRANSCRIPT_UPDATE" && message.meetingId === meetingId) {
      appendTranscriptLine(transcriptView, message.speaker, message.text);
    }
    if (message.type === "SUMMARY_READY" && message.meetingId === meetingId) {
      clearLiveListener();
      void renderSafely();
    }
    // A failed recording used to leave this exact view showing a "live"
    // transcript that had actually stopped updating, with no visible sign
    // anything went wrong — the toolbar badge (see background.ts) covers
    // the case where the popup is closed when this happens; re-rendering
    // out of the dead "recording" view covers the case where it's open.
    if (message.type === "RECORDING_ERROR" && message.meetingId === meetingId) {
      clearLiveListener();
      void renderSafely();
    }
    if (message.type === "PROCESSING_WARNING" && message.meetingId === meetingId) {
      const status = document.getElementById("status");
      if (status) status.textContent = "A transcription chunk will be retried automatically.";
    }
  }
  chrome.runtime.onMessage.addListener(liveListener);
  removeLiveListener = () => chrome.runtime.onMessage.removeListener(liveListener);
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
      <span class="meeting-meta text-secondary">${formatRelativeDate(meeting.startedAt)}${statusLabel}</span>
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

async function renderAudioStatus(helperStatus: BackgroundState["helperStatus"]): Promise<void> {
  const statusEl = document.getElementById("audio-status");
  const checkButton = document.getElementById("check-audio") as HTMLButtonElement | null;
  const probeButton = document.getElementById("test-audio") as HTMLButtonElement | null;
  if (!statusEl) return;
  statusEl.textContent = "Checking audio devices…";
  statusEl.className = "text-secondary";
  try {
    const response = await sendToBackground<{ status: AudioStatus }>({ type: "GET_AUDIO_PREFLIGHT" });
    const status = response.status;
    const deviceLine = [status.microphone ? `Mic: ${status.microphone}` : "Mic: missing", status.speaker ? `Meeting audio: ${status.speaker}` : "Meeting audio: missing"].join(" · ");
    const readiness = !status.driverInstalled
      ? "Audio driver missing."
      : status.ready
        ? "Audio ready."
        : "Audio routing incomplete.";
    statusEl.textContent = `${readiness} ${deviceLine} ${status.guidance}`;
    statusEl.className = status.ready ? "text-success" : "text-warning";
    if (checkButton) checkButton.textContent = status.ready ? "Refresh audio check" : "Check audio again";
    if (probeButton) probeButton.disabled = !status.ready;
    const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (startButton) startButton.disabled = !status.ready || helperStatus !== "connected";
  } catch {
    statusEl.textContent = "Audio check failed. Confirm the desktop helper is running, then try again.";
    statusEl.className = "text-warning";
    if (probeButton) probeButton.disabled = true;
    const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (startButton) startButton.disabled = true;
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

async function renderIdleState(helperStatus: BackgroundState["helperStatus"], settings: Awaited<ReturnType<typeof getSettings>>): Promise<void> {
  const meetings = await listMeetings(historyQuery ? undefined : 5, historyQuery || undefined);
  const helperStatusCopy =
    helperStatus === "connecting"
      ? "Connecting to the desktop helper…"
      : helperStatus === "disconnected"
        ? "Desktop helper disconnected — start it before recording."
        : helperStatus === "incompatible"
          ? "Desktop helper needs an update before recording."
        : "";
  app.innerHTML = `
    ${renderHeader(true)}
    ${helperStatusCopy ? `<p class="text-secondary" role="status">${helperStatusCopy}</p>` : ""}
    <div class="record-controls">
      <button class="primary record-toggle" id="start-recording" disabled>Record</button>
      <label class="meeting-mode-picker" for="meeting-mode">Meeting mode
        <select id="meeting-mode">${meetingModeOptions(settings.defaultMeetingMode)}</select>
      </label>
      <div class="audio-check" aria-live="polite">
        <p id="audio-status" class="text-secondary">Checking audio devices…</p>
        <div class="audio-check-actions">
          <button type="button" class="secondary" id="check-audio">Check audio</button>
          <button type="button" class="secondary" id="test-audio" disabled>Run 2-second test</button>
        </div>
      </div>
    </div>
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
          : `<p class="empty-state">${historyQuery ? `No meetings match “${escapeHtml(historyQuery)}”.` : "No meetings yet — hit Record during your next call."}</p>`
      }
    </div>
  `;
  document.getElementById("start-recording")?.addEventListener("click", async () => {
    const startButton = document.getElementById("start-recording") as HTMLButtonElement | null;
    if (startButton) startButton.disabled = true;
    try {
      const meetingMode = (document.getElementById("meeting-mode") as HTMLSelectElement).value as MeetingMode;
      await sendToBackground({ type: "START_RECORDING", meetingMode });
      await renderSafely();
    } catch (error) {
      renderFailure(error);
    }
  });
  document.getElementById("check-audio")?.addEventListener("click", () => void renderAudioStatus(helperStatus));
  document.getElementById("test-audio")?.addEventListener("click", () => void runAudioProbe());
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
  void renderAudioStatus(helperStatus);
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
    await renderActiveRecording(state.activeMeeting.id);
  } else {
    await renderIdleState(state.helperStatus, settings);
  }

  if (state.recoverableMeeting) {
    await renderRecoverableBanner(state.recoverableMeeting);
  }

  // Only worth surfacing once onboarding is done and there's no active
  // recording already in view — a "helper not found" banner while the user
  // is mid-setup, or stacked on top of a live recording that started
  // before the helper dropped, would be noise rather than help.
  if ((state.helperStatus === "helper_not_found" || state.helperStatus === "incompatible") && !state.activeMeeting) {
    renderHelperMissingBanner(state.helperStatus, state.helperInfo);
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
