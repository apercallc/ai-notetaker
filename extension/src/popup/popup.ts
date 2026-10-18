import { getMeeting, getSettings, listMeetings } from "../lib/storage";
import { sendToBackground } from "../lib/sendToBackground";
import { escapeHtml } from "../lib/html";
import { getInstallPageUrl } from "../lib/install";
import { browserTitleForTab, isRecordableTabUrl } from "../meet/meetContext";
import { takePendingMeetStart } from "../meet/pendingStart";
import type { BackgroundState } from "../lib/internalMessages";
import type { MeetingRecord } from "../types";
import { createStopConfirm, STOP_CONFIRM_LABEL, STOP_LABEL } from "../lib/stopConfirm";

const app = document.getElementById("app")!;
let busy = false;
/** What went wrong, and in which part of the flow, so the heading says the right thing. */
type ErrorKind = "start" | "stopped" | "action";
let error: { kind: ErrorKind; message: string } | null = null;
const ERROR_HEADINGS: Record<ErrorKind, string> = {
  start: "Recording didn’t start.",
  stopped: "Recording stopped.",
  action: "That didn’t work.",
};
const REASON_LIMIT = 140;
const NO_TAB_COPY = "Go to your meeting tab, then click the AI Notetaker icon again.";
/** The armed Stop from the previous render; a re-render replaces its button, so it is cancelled. */
let stopConfirm: { cancel: () => void } | null = null;

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: MeetingRecord["status"]): string {
  switch (status) {
    case "saved": return "Audio saved";
    case "recording": return "Recording";
    case "complete": return "Notes ready";
    case "processing": return "Legacy notes processing";
    default: return "Needs attention";
  }
}

/** A short, single-line reason for a failed meeting; the meeting page has the full text. */
function briefReason(message: string | undefined): string {
  const text = (message ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Something went wrong with this recording. Any audio saved before it stopped is kept.";
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT - 1).trimEnd()}…` : text;
}

/** Plain-text-escaped list row. Every value from storage goes through escapeHtml. */
function historyItem(meeting: MeetingRecord): string {
  const title = escapeHtml(meeting.title);
  const id = escapeHtml(meeting.id);
  const failed = meeting.status === "error";
  return `<li${failed ? ' class="needs-attention"' : ""}>
    <strong>${title}</strong>
    <span>${escapeHtml(dateLabel(meeting.startedAt))} · ${failed ? `<span class="status-attention">${statusLabel(meeting.status)}</span>` : statusLabel(meeting.status)}</span>
    ${failed ? `<p class="history-reason">${escapeHtml(briefReason(meeting.errorMessage))}</p>` : ""}
    ${meeting.status === "complete" ? `<button type="button" class="text-link" data-open-meeting="${id}" aria-label="Open notes for ${title}">Open notes</button>` : ""}
    ${failed ? `<button type="button" class="text-link" data-open-meeting="${id}" aria-label="View details for ${title}">View details</button>` : ""}
  </li>`;
}

/**
 * Re-rendering replaces the whole view, which would drop keyboard focus onto
 * the page. Remember what had focus and put it back on its replacement.
 */
function focusKey(): (() => HTMLElement | null) | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || !app.contains(active)) return null;
  if (active.classList.contains("record-toggle")) return () => app.querySelector<HTMLElement>(".record-toggle");
  const meetingId = active.dataset.openMeeting;
  if (meetingId) return () => [...app.querySelectorAll<HTMLElement>("[data-open-meeting]")].find((element) => element.dataset.openMeeting === meetingId) ?? null;
  const id = active.id;
  return id ? () => document.getElementById(id) : null;
}

async function activeBrowserTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && isRecordableTabUrl(tab.url) ? tab : undefined;
}

/**
 * Renders never overlap. A request that arrives while one is in flight is
 * coalesced into a single follow-up render, so the view always ends on the
 * newest state and a slow, older render can never paint over a newer one.
 */
let rendering: Promise<void> | null = null;
let renderAgain = false;
function render(): Promise<void> {
  if (rendering) {
    renderAgain = true;
    return rendering;
  }
  rendering = (async () => {
    do {
      renderAgain = false;
      await renderOnce();
    } while (renderAgain);
  })().finally(() => {
    rendering = null;
  });
  return rendering;
}

async function renderOnce(): Promise<void> {
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
    // The intro is for getting started; it steps aside once there are
    // recordings, and never competes with a meeting in progress.
    const showIntro = (!ready || recent.length === 0) && !state.activeMeeting;
    const restoreFocus = focusKey();
    stopConfirm?.cancel();
    stopConfirm = null;
    app.innerHTML = `
      <header class="app-header"><div class="brand-lockup"><img src="../icons/icon48.png" alt="" /><h1>AI Notetaker</h1></div><button type="button" class="icon-button" id="open-settings">Settings</button></header>
      ${showIntro ? `<section class="banner" aria-labelledby="recorder-intro">
        <strong id="recorder-intro">Browser meeting recorder</strong>
        <p>Records Google Meet, Microsoft Teams, Zoom, Discord, and Slack calls in Chrome. Your microphone and the meeting audio are saved separately, on this computer. Let everyone know before you record.</p>
      </section>` : ""}
      ${error ? `<p class="start-error" role="alert"><strong>${ERROR_HEADINGS[error.kind]}</strong> ${escapeHtml(error.message)}</p>` : ""}
      ${state.recoverableMeeting ? `<section class="banner recoverable" id="recoverable-banner" aria-labelledby="recoverable-heading"><strong id="recoverable-heading">An interrupted recording was found</strong><p>Started ${escapeHtml(dateLabel(state.recoverableMeeting.startedAt))}. Resume it, or discard its saved audio.</p><div class="banner-actions"><button type="button" class="primary" id="resume-recording" data-meeting="${escapeHtml(state.recoverableMeeting.meetingId)}">Resume recording</button><button type="button" class="secondary" id="discard-recording" data-meeting="${escapeHtml(state.recoverableMeeting.meetingId)}">Discard</button></div></section>` : ""}
      ${state.activeMeeting && !activeMeet ? '<p class="banner">Another recording is in progress. Finish it before starting a browser recording.</p>' : ""}
      <div class="record-controls">
        ${activeMeet
          ? `<p role="status"><span class="recording-indicator">Recording</span> <strong>${escapeHtml(activeMeet.title)}</strong>. Audio is being saved on this computer.</p><button type="button" class="danger record-toggle" id="stop-recording" ${busy ? "disabled" : ""}>${STOP_LABEL}</button>`
          : !ready
            ? '<p>Allow the microphone and confirm you’ll tell people you’re recording, then you’re set.</p><button type="button" class="primary record-toggle" id="open-setup">Set up browser recording</button>'
            : `<p>${tab ? `Ready to record <strong>${escapeHtml(browserTitleForTab(tab) || "this tab")}</strong>.` : escapeHtml(NO_TAB_COPY)}</p><button type="button" class="primary record-toggle" id="start-recording" ${!tab || busy || state.activeMeeting ? "disabled" : ""}>Start recording</button>`}
      </div>
      <section class="history-section" aria-labelledby="history-heading"><h2 id="history-heading">Saved browser recordings</h2>
        ${recent.length
          ? `<ul class="recorder-list">${recent.map(historyItem).join("")}</ul>`
          : '<p class="text-secondary">No browser recordings yet.</p>'}
        ${recent.length ? '<p class="text-secondary">To make notes, export your recordings and import them in the desktop app.</p>' : ""}
        <div class="history-actions">
          ${recent.length ? '<button type="button" class="secondary" id="export-recordings">Export recordings</button>' : ""}
          <button type="button" class="text-link" id="get-desktop">Get the desktop app</button>
        </div>
      </section>`;
    restoreFocus?.()?.focus();

    document.getElementById("open-settings")?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
    document.getElementById("export-recordings")?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
    document.getElementById("get-desktop")?.addEventListener("click", () => void chrome.tabs.create({ url: getInstallPageUrl("popup") }));
    document.getElementById("open-setup")?.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") }));
    document.getElementById("start-recording")?.addEventListener("click", () => void run("start", "start-recording", async () => {
      if (typeof tab?.id !== "number") throw new Error(NO_TAB_COPY);
      const result = await sendToBackground<{ meetingId: string }>({ type: "START_RECORDING", captureSource: "meet", tabId: tab.id, meetingMode: settings.defaultMeetingMode, titleHint: browserTitleForTab(tab) });
      if (!result.meetingId) throw new Error("Check microphone access and try again.");
    }));
    document.getElementById("resume-recording")?.addEventListener("click", (event) => void run("action", null, async () => {
      await sendToBackground({ type: "RESUME_RECORDING", meetingId: (event.currentTarget as HTMLElement).dataset.meeting! });
    }));
    document.getElementById("discard-recording")?.addEventListener("click", (event) => void run("action", null, async () => {
      if (!confirm("Discard this interrupted recording and its saved audio?")) return;
      await sendToBackground({ type: "DISCARD_RECORDING", meetingId: (event.currentTarget as HTMLElement).dataset.meeting! });
    }));
    const stopButton = document.getElementById("stop-recording") as HTMLButtonElement | null;
    if (stopButton && activeMeet) {
      // Stopping ends the recording for good, so the popup asks the same way
      // the in-call controls do: press once to arm, again to stop.
      const confirm = createStopConfirm({
        arm: () => {
          stopButton.classList.add("armed");
          stopButton.setAttribute("aria-label", "Press again to stop recording");
          stopButton.textContent = STOP_CONFIRM_LABEL;
        },
        disarm: () => {
          stopButton.classList.remove("armed");
          stopButton.removeAttribute("aria-label");
          stopButton.textContent = STOP_LABEL;
        },
        confirm: () => {
          stopConfirm = null;
          void run("action", "stop-recording", async () => {
            await sendToBackground({ type: "STOP_RECORDING", meetingId: activeMeet.id });
          });
        },
      });
      stopConfirm = confirm;
      stopButton.addEventListener("click", confirm.press);
    }
    for (const button of app.querySelectorAll<HTMLButtonElement>("[data-open-meeting]")) {
      button.addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(button.dataset.openMeeting!)}`) }));
    }
    // Opening the popup invokes the extension on this tab. Complete a widget
    // start that Chrome previously held behind that invocation gate.
    if (ready && tab?.id !== undefined && !state.activeMeeting && !busy) {
      const intent = await takePendingMeetStart(tab.id);
      if (intent?.tabId === tab.id) {
        void run("start", "start-recording", async () => {
          const result = await sendToBackground<{ meetingId: string }>({
            type: "START_RECORDING",
            captureSource: "meet",
            tabId: tab.id!,
            // The notes style picked in the widget wins; takePendingMeetStart already dropped an unknown one.
            meetingMode: intent.meetingMode ?? settings.defaultMeetingMode,
            ...(intent.titleHint ? { titleHint: intent.titleHint } : {}),
          });
          if (!result.meetingId) throw new Error("Check microphone access and try again.");
        });
      }
    }
  } catch (cause) {
    app.innerHTML = `<p class="start-error" role="alert"><strong>The recorder couldn’t open.</strong> ${escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p><button type="button" class="secondary" id="retry">Try again</button>`;
    document.getElementById("retry")?.addEventListener("click", () => void render());
  }
}

/**
 * Runs one popup action. Every control is disabled while it runs, but only the
 * button that started it (if any) says what is happening.
 */
async function run(kind: ErrorKind, buttonId: "start-recording" | "stop-recording" | null, action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  for (const button of app.querySelectorAll<HTMLButtonElement>(".record-toggle")) button.disabled = true;
  const button = buttonId ? (document.getElementById(buttonId) as HTMLButtonElement | null) : null;
  if (button) {
    button.classList.remove("armed");
    button.removeAttribute("aria-label");
    button.textContent = buttonId === "stop-recording" ? "Stopping…" : "Starting…";
  }
  try {
    await action();
  } catch (cause) {
    error = { kind, message: cause instanceof Error ? cause.message : "The recording could not be changed." };
  } finally {
    busy = false;
    await render();
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; phase?: string; message?: string; meetingId?: string | null }) => {
  if (message.type === "RECORDING_ERROR" && message.phase === "start") {
    error = { kind: "start", message: message.message ?? "Try again." };
    void render();
  } else if (message.type === "RECORDING_ERROR" && message.meetingId) {
    // A capture that failed mid-call ends the recording without a separate
    // state change; without this an open popup kept offering Stop for it.
    error = { kind: "stopped", message: message.message ?? "Audio saved so far is kept." };
    void render();
  } else if (message.type === "MEETING_STATE_CHANGED" || message.type === "SUMMARY_READY") {
    void render();
  }
});
void render();
