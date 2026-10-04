import { escapeHtml } from "../lib/html";
import type { WidgetState } from "../lib/internalMessages";
import { shortcutKeys } from "../lib/shortcuts";
import { CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT } from "../meet/hints";
import type { MeetingMode } from "../types";
import { STOP_LABEL } from "../lib/stopConfirm";
import { canStart, formatElapsed, type WidgetUi, type WidgetView } from "./widgetModel";

/** Everything the templates read. They are pure: same context, same markup. */
export interface TemplateContext {
  state: WidgetState | null;
  ui: WidgetUi;
  expanded: boolean;
  now: number;
  selectedMode: MeetingMode | null;
}

export const ICONS = {
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v17l-6-4-6 4Z"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
};

export function keysHtml(shortcut: string): string {
  return `<span class="keys">${shortcutKeys(shortcut)
    .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
    .join("")}</span>`;
}

export function errorMessage(ctx: TemplateContext): string {
  return ctx.ui.error ?? ctx.state?.latest?.errorMessage ?? "Something went wrong.";
}

export const PILL_LABELS: Partial<Record<WidgetView, string>> = {
  recording: "Recording",
  starting: "Starting…",
  processing: "Writing notes…",
  saved: "Audio saved",
  done: "Notes ready",
  error: "Needs attention",
  disconnected: "Reload to reconnect",
};

/** Everything the idle panel shows that can change under it, so it re-renders only when one does. */
export function readyKey(state: WidgetState | null): string {
  return JSON.stringify([state?.callTitle, state?.shortcuts, canStart(state), state?.onboardingComplete, state?.consentAcknowledged]);
}

export function renderPill(view: WidgetView, ctx: TemplateContext): string {
  const { state } = ctx;
  const recording = view === "recording";
  const elapsed = recording && state?.active ? formatElapsed(state.active.startedAt, ctx.now) : "";
  const label = PILL_LABELS[view] ?? "Notetaker";
  const panelAction = ctx.expanded ? "Collapse notes panel" : "Expand notes panel";
  const quickStart = view === "ready" && canStart(state);
  const hint = (text: string, keys: string | undefined): string => escapeHtml(keys ? `${text} (${keys})` : text);
  return `
      <div class="pill" role="group" aria-label="AI Notetaker" title="Drag to move, or focus and use the arrow keys">
        <button type="button" class="pill-main" id="toggle" aria-label="${escapeHtml(`${panelAction}, status ${label}`)}" aria-expanded="${ctx.expanded}" aria-controls="panel">
          <span class="dot" aria-hidden="true"></span>
          <span>${escapeHtml(label)}</span>
          ${recording ? `<span class="elapsed" id="elapsed" role="timer">${elapsed}</span>` : ""}
        </button>
        ${quickStart ? `<button type="button" class="pill-start" id="pill-start" title="${hint("Start recording", state?.shortcuts.toggle)}">Start recording</button>` : ""}
        ${
          recording
            ? `<button type="button" class="icon-btn" id="pill-bookmark" aria-label="Flag this moment" title="${hint("Flag this moment", state?.shortcuts.bookmark)}">${ICONS.bookmark}</button>
               <span class="divider" aria-hidden="true"></span>
               <button type="button" class="icon-btn stop" id="pill-stop" aria-label="${STOP_LABEL}" title="${hint(STOP_LABEL, state?.shortcuts.toggle)}">${ICONS.stop}</button>`
            : ""
        }
        <button type="button" class="icon-btn chevron" id="chevron" aria-label="${ctx.expanded ? "Collapse notes panel" : "Expand notes panel"}" tabindex="-1">${ICONS.chevron}</button>
      </div>`;
}

export function renderPanel(view: WidgetView, ctx: TemplateContext): string {
  switch (view) {
    case "disconnected":
      return `
          <div class="stack">
            <div><h2>AI Notetaker was updated</h2><p class="sub">Reload this tab to reconnect. Reloading rejoins your call.</p></div>
            <button type="button" class="btn secondary block" id="reload">Reload tab</button>
          </div>`;
    case "setup":
      return `
          <div class="stack">
            <div><h2>Finish recording setup</h2><p class="sub">Allow the microphone and confirm you will tell everyone before recording.</p></div>
            <button type="button" class="btn primary block" id="open-setup">Open setup</button>
          </div>`;
    case "starting":
      return `
          <div class="stack">
            <div><h2>Connecting to the call audio…</h2><p class="sub">${startingCopy(ctx.state)}</p></div>
          </div>`;
    case "processing": {
      const preflightWarning = ctx.state?.latest?.providerPreflightWarning;
      return `
          <div class="stack">
            <div><h2>Writing your notes…</h2><p class="sub">${preflightWarning ? "Your audio is saved on this device. A provider check failed before recording, so notes may take longer or need a retry." : "Processing can take a few minutes. You can leave the call; notes will appear here when ready. If a provider fails, the audio stays available for retry."}</p></div>
            ${preflightWarning ? `<p class="note warn" role="status">A provider connection check failed before recording: ${escapeHtml(preflightWarning)}</p>` : ctx.ui.warning ? `<p class="note warn" role="status">Still trying: ${escapeHtml(ctx.ui.warning)} If this keeps happening, check your API keys in AI Notetaker settings.</p>` : ""}
            <button type="button" class="btn secondary block" id="open-notes">Open notes</button>
            <button type="button" class="btn secondary block" id="dismiss">Hide and keep going</button>
          </div>`;
    }
    case "done":
      return `
          <div class="stack">
            <div><h2>Your notes are ready</h2><p class="sub">${escapeHtml(ctx.state?.latest?.title ?? "")}</p></div>
            <button type="button" class="btn primary block" id="open-notes">Open notes</button>
            <button type="button" class="btn secondary block" id="dismiss">Dismiss</button>
          </div>`;
    case "saved":
      return `
          <div class="stack">
            <div><h2>Meet audio saved</h2><p class="sub">Your microphone and the call audio are stored on this device. Export them from extension Settings and import the archive in the desktop app to make notes.</p></div>
            <button type="button" class="btn primary block" id="open-ai-settings">Export recordings</button>
            <button type="button" class="btn secondary block" id="dismiss">Dismiss</button>
          </div>`;
    case "error":
      return renderError(ctx);
    case "recording":
      return `
          <div class="stack">
            ${ctx.state?.active?.providerPreflightWarning ? `<p class="note warn" role="alert">AI provider check: ${escapeHtml(ctx.state.active.providerPreflightWarning)} <button type="button" class="link" id="open-ai-settings">Open AI settings</button></p>` : ""}
            ${
              ctx.state?.disclosureNoticeEnabled
                ? `<div class="disclosure" id="disclosure-card">
              <p class="note" id="disclosure-text">Notify the call: this meeting is being recorded.</p>
              <button type="button" class="btn secondary block" id="copy-disclosure">Copy notice for chat</button>
            </div>`
                : ""
            }
              ${
              !ctx.state?.active?.recorderOnly && (ctx.state?.helperStatus === "connected" || ctx.state?.active?.captureSource === "meet" || ctx.state?.active?.captureSource === "meet_tab")
                ? `<div class="transcript-wrap">
              <div class="transcript" id="transcript" role="log" aria-live="off" aria-label="Live transcript" tabindex="0"></div>
              <button type="button" class="jump" id="jump" hidden>Jump to latest</button>
            </div>`
                : `<p class="sub" id="written-on-stop">Recording. Your microphone and Meet audio are being saved separately on this device.</p>`
            }
            <form class="row" id="moment-form" autocomplete="off">
              <input type="text" id="moment-note" maxlength="280" placeholder="Add a note to this moment" aria-label="Note for this moment (optional)" />
              <button type="submit" class="btn secondary" id="moment-submit">Flag</button>
            </form>
            <div id="moments-wrap" hidden><p class="section-label">Flagged moments</p><ul class="moments" id="moments"></ul></div>
            <button type="button" class="btn danger block" id="stop">${STOP_LABEL}</button>
          </div>`;
    default:
      return renderReady(ctx);
  }
}

function renderError(ctx: TemplateContext): string {
  const message = errorMessage(ctx);
  const needsCaptureInvocation = message === CAPTURE_PERMISSION_HINT;
  const needsProviderConfirmation = ctx.ui.errorRecovery === "provider_preflight";
  const retryable = ctx.ui.error !== null && !needsCaptureInvocation && !needsProviderConfirmation;
  const needsMic = message === MIC_PERMISSION_HINT;
  const shortcutHint =
    needsCaptureInvocation && ctx.state?.shortcuts.toggle ? ` Or press ${keysHtml(ctx.state.shortcuts.toggle)} on this tab.` : "";
  const recoveryHint =
    ctx.ui.errorRecovery === "check_provider_key"
      ? "Check the selected provider key in Settings."
      : ctx.ui.errorRecovery === "check_audio"
        ? "Check both microphone and meeting-audio devices before trying again."
        : ctx.ui.errorRecovery === "update_helper"
          ? "Install the matching desktop helper version, then check again."
          : ctx.ui.errorRecovery === "check_billing"
            ? "Open Hosted AI billing in Settings to choose a plan or resolve payment."
          : ctx.ui.errorRecovery === "sign_in"
            ? "Sign in to Hosted AI again before retrying."
            : "";
  return `
          <div class="stack">
            <div><h2>${needsCaptureInvocation ? "One Chrome step" : needsProviderConfirmation ? "Provider check needs attention" : "Recording needs attention"}</h2></div>
            <p class="note ${needsCaptureInvocation ? "warning" : "error"}">${escapeHtml(message)}${shortcutHint}${recoveryHint ? ` ${escapeHtml(recoveryHint)}` : ""}</p>
            <div class="row">
              ${needsProviderConfirmation ? `<button type="button" class="btn secondary" id="open-ai-settings">Open AI settings</button><button type="button" class="btn primary" id="continue-anyway">Record anyway</button>` : ""}
              ${needsMic ? `<button type="button" class="btn primary" id="allow-mic">Allow microphone</button>` : ""}
              ${retryable ? `<button type="button" class="btn ${needsMic ? "secondary" : "primary"}" id="retry">Try again</button>` : needsCaptureInvocation ? "" : `<button type="button" class="btn primary" id="open-notes">Open details</button>`}
              <button type="button" class="btn secondary" id="dismiss">${needsCaptureInvocation ? "Got it" : "Dismiss"}</button>
            </div>
          </div>`;
}

function startingCopy(state: WidgetState | null): string {
  void state;
  return "Connecting to this Meet tab and microphone. Audio will be saved on this device.";
}

function renderReady(ctx: TemplateContext): string {
  const { state } = ctx;
  void ctx.selectedMode;
  const intro = state?.callTitle
    ? `Record <strong>${escapeHtml(state.callTitle)}</strong> and export it to the desktop app after the call.`
    : "Save this Meet call locally and export it to the desktop app after the call.";
  const startHint = state?.shortcuts.toggle
    ? `Start recording here, or press ${keysHtml(state.shortcuts.toggle)}.`
    : `Start recording here when everyone is ready. <button type="button" class="link" id="set-shortcut">Set a shortcut</button>`;
  return `
      <div class="stack">
        <div><h2>Ready when you are</h2><p class="sub">${intro}</p></div>
        <p class="note" id="start-hint">${startHint}</p>
        <p class="sub">Audio is saved in Chrome until you export it. No provider key is needed to record.</p>
        <p class="consent"><strong>Nobody else is notified.</strong> Tell everyone you're recording; some places require everyone's consent.</p>
        <button type="button" class="btn secondary block" id="start"${canStart(state) ? "" : " disabled"}>Start recording</button>
      </div>`;
}
