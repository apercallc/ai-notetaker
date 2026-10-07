import { getMeeting, getSettings, listMeetings } from "../lib/storage";
import { sendToBackground } from "../lib/sendToBackground";
import { escapeHtml } from "../lib/html";
import { getInstallPageUrl } from "../lib/install";
import { browserTitleForTab, isRecordableTabUrl } from "../meet/meetContext";
import { takePendingMeetStart } from "../meet/pendingStart";
import type { BackgroundState } from "../lib/internalMessages";
import type { MeetingRecord } from "../types";

const app = document.getElementById("app")!;
let busy = false;
let error = "";

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

async function activeBrowserTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && isRecordableTabUrl(tab.url) ? tab : undefined;
}

async function render(): Promise<void> {
  try {
    const [state, settings, meetings, tab] = await Promise.all([
      sendToBackground<BackgroundState>({ type: "GET_STATE" }),
      getSettings(),
      listMeetings(5, undefined, "meet"),
      activeBrowserTab(),
    ]);
    const active = state.activeMeeting ? await getMeeting(state.activeMeeting.id) : null;
    const activeMeet = active?.captureSource === "meet" ? active : null;
    const recent = meetings;
    const ready = settings.onboardingComplete && settings.consentDisclosureAcknowledged;
    app.innerHTML = `
      <header class="app-header"><div class="brand-lockup"><img src="../icons/icon48.png" alt="" /><h1>AI Notetaker</h1></div><button class="icon-button" id="open-settings" aria-label="Open recording settings">Settings</button></header>
      <section class="banner">
        <strong>Browser meeting recorder</strong>
        <p>For Google Meet, Microsoft Teams, Zoom, Discord calls, and Slack huddles playing in Chrome. Your microphone and this tab’s audio stay separate and local. Tell everyone before you record.</p>
      </section>
      ${error ? `<p class="start-error" role="alert">${escapeHtml(error)}</p>` : ""}
      ${state.activeMeeting && !activeMeet ? '<p class="banner">Another recording is active. Finish it before starting a browser recording.</p>' : ""}
      <div class="record-controls">
        ${activeMeet
          ? `<p role="status">Recording <strong>${escapeHtml(activeMeet.title)}</strong>. Audio is being saved locally.</p><button class="danger record-toggle" id="stop-recording" ${busy ? "disabled" : ""}>Stop recording</button>`
          : !ready
            ? '<p>Allow the microphone and acknowledge recording consent to begin.</p><button class="primary record-toggle" id="open-setup">Set up browser recording</button>'
            : `<p>${tab ? `Ready to record audio from <strong>${escapeHtml(browserTitleForTab(tab) || "this tab")}</strong>.` : "Open a secure browser meeting tab to start recording."}</p><button class="primary record-toggle" id="start-recording" ${!tab || busy || state.activeMeeting ? "disabled" : ""}>Start recording</button>`}
      </div>
      <section class="history-section"><h2>Saved browser recordings</h2>
        ${recent.length
          ? `<ul class="recorder-list">${recent.map((meeting: MeetingRecord) => `<li><strong>${escapeHtml(meeting.title)}</strong><span>${escapeHtml(dateLabel(meeting.startedAt))} · ${meeting.status === "saved" ? "Audio saved" : meeting.status === "recording" ? "Recording" : meeting.status === "complete" ? "Legacy notes ready" : meeting.status === "processing" ? "Legacy notes processing" : "Needs attention"}</span>${meeting.status === "complete" ? `<button class="text-link" data-open-meeting="${escapeHtml(meeting.id)}">Open legacy notes</button>` : ""}</li>`).join("")}</ul>`
          : '<p class="text-secondary">No browser recordings yet.</p>'}
        <p class="text-secondary">Export saved audio from Settings, then import it in the desktop app to transcribe and make notes.</p>
        <button class="secondary" id="export-recordings">Open export settings</button>
        <button class="text-link" id="get-desktop">Get the desktop app</button>
      </section>`;

    document.getElementById("open-settings")?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
    document.getElementById("export-recordings")?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
    document.getElementById("get-desktop")?.addEventListener("click", () => void chrome.tabs.create({ url: getInstallPageUrl("popup") }));
    document.getElementById("open-setup")?.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") }));
    document.getElementById("start-recording")?.addEventListener("click", () => void run(async () => {
      if (typeof tab?.id !== "number") throw new Error("Open a secure browser meeting tab first.");
      const result = await sendToBackground<{ meetingId: string }>({ type: "START_RECORDING", captureSource: "meet", tabId: tab.id, titleHint: browserTitleForTab(tab) });
      if (!result.meetingId) throw new Error("Capture did not start. Check microphone access and try again.");
    }));
    document.getElementById("stop-recording")?.addEventListener("click", () => void run(async () => {
      if (activeMeet) await sendToBackground({ type: "STOP_RECORDING", meetingId: activeMeet.id });
    }));
    for (const button of app.querySelectorAll<HTMLButtonElement>("[data-open-meeting]")) {
      button.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(button.dataset.openMeeting!)}`) }));
    }
    // Opening the popup invokes the extension on this tab. Complete a widget
    // start that Chrome previously held behind that invocation gate.
    if (ready && tab?.id !== undefined && !state.activeMeeting && !busy) {
      const intent = await takePendingMeetStart(tab.id);
      if (intent?.tabId === tab.id) {
        void run(async () => {
          const result = await sendToBackground<{ meetingId: string }>({
            type: "START_RECORDING",
            captureSource: "meet",
            tabId: tab.id!,
            ...(intent.titleHint ? { titleHint: intent.titleHint } : {}),
          });
          if (!result.meetingId) throw new Error("Capture did not start. Check microphone access and try again.");
        });
      }
    }
  } catch (cause) {
    app.innerHTML = `<p role="alert">The recorder could not open. ${escapeHtml(String(cause))}</p><button class="secondary" id="retry">Try again</button>`;
    document.getElementById("retry")?.addEventListener("click", () => void render());
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  error = "";
  for (const button of app.querySelectorAll<HTMLButtonElement>(".record-toggle")) {
    button.disabled = true;
    button.textContent = button.id === "stop-recording" ? "Stopping…" : "Starting…";
  }
  try {
    await action();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "The recording could not be changed.";
  } finally {
    busy = false;
    await render();
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; phase?: string; message?: string }) => {
  if (message.type === "RECORDING_ERROR" && message.phase === "start") {
    error = message.message ?? "Capture did not start.";
    void render();
  } else if (message.type === "MEETING_STATE_CHANGED") {
    void render();
  }
});
void render();
