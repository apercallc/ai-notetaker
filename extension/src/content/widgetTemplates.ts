import { escapeHtml } from "../lib/html";
import type { WidgetState } from "../lib/internalMessages";
import { shortcutKeys } from "../lib/shortcuts";
import { CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT } from "../meet/hints";
import type { MeetingMode } from "../types";
import { canStart, formatElapsed, helperNotice, type WidgetUi, type WidgetView } from "./widgetModel";

/** Everything the templates read. They are pure: same context, same markup. */
export interface TemplateContext {
  state: WidgetState | null;
  ui: WidgetUi;
  expanded: boolean;
  now: number;
  selectedMode: MeetingMode | null;
}

const MODES: Array<[MeetingMode, string]> = [
  ["general", "General"],
  ["standup", "Standup"],
  ["sales", "Sales call"],
  ["one_on_one", "1:1"],
  ["interview", "Interview"],
  ["custom", "Custom template"],
];

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

const PILL_LABELS: Partial<Record<WidgetView, string>> = {
  recording: "Recording",
  starting: "Starting…",
  processing: "Writing notes…",
  done: "Notes ready",
  error: "Needs attention",
  disconnected: "Reload to reconnect",
};

/** Everything the idle panel shows that can change under it, so it re-renders only when one does. */
export function readyKey(state: WidgetState | null): string {
  return JSON.stringify([state?.callTitle, state?.shortcuts, helperNotice(state), canStart(state), state?.onboardingComplete, state?.consentAcknowledged]);
}

export function renderPill(view: WidgetView, ctx: TemplateContext): string {
  const { state } = ctx;
  const recording = view === "recording";
  const elapsed = recording && state?.active ? formatElapsed(state.active.startedAt, ctx.now) : "";
  const label = PILL_LABELS[view] ?? "Notetaker";
  const quickStart = view === "ready" && canStart(state);
  const hint = (text: string, keys: string | undefined): string => escapeHtml(keys ? `${text} (${keys})` : text);
  return `
      <div class="pill" role="group" aria-label="AI Notetaker" title="Drag to move, or focus and use the arrow keys">
        <button type="button" class="pill-main" id="toggle" aria-label="${escapeHtml(label)}" aria-expanded="${ctx.expanded}" aria-controls="panel">
          <span class="dot" aria-hidden="true"></span>
          <span>${escapeHtml(label)}</span>
          ${recording ? `<span class="elapsed" id="elapsed" role="timer">${elapsed}</span>` : ""}
        </button>
        ${quickStart ? `<button type="button" class="pill-start" id="pill-start" title="${hint("Start taking notes", state?.shortcuts.toggle)}">Start</button>` : ""}
        ${
          recording
            ? `<button type="button" class="icon-btn" id="pill-bookmark" aria-label="Flag this moment" title="${hint("Flag this moment", state?.shortcuts.bookmark)}">${ICONS.bookmark}</button>
               <span class="divider" aria-hidden="true"></span>
               <button type="button" class="icon-btn stop" id="pill-stop" aria-label="Stop recording and write notes" title="${hint("Stop and write notes", state?.shortcuts.toggle)}">${ICONS.stop}</button>`
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
            <div><h2>Notetaker was updated</h2><p class="sub">Reload this tab to reconnect. Reloading rejoins your call.</p></div>
            <button type="button" class="btn secondary block" id="reload">Reload tab</button>
          </div>`;
    case "setup":
      return `
          <div class="stack">
            <div><h2>Finish setup to start</h2><p class="sub">Connect the desktop helper, add your API keys, and confirm the recording notice. It takes about two minutes.</p></div>
            <button type="button" class="btn primary block" id="open-setup">Open setup</button>
          </div>`;
    case "starting":
      return `
          <div class="stack">
            <div><h2>Connecting to the call audio…</h2><p class="sub">Audio is saved on this device and sent to your own transcription provider with your key.</p></div>
          </div>`;
    case "processing":
      return `
          <div class="stack">
            <div><h2>Writing your notes…</h2><p class="sub">This usually takes under a minute. You can leave the call; the notes will be waiting.</p></div>
            ${ctx.ui.warning ? `<p class="note warn" role="status">Still trying: ${escapeHtml(ctx.ui.warning)} If this keeps happening, check your API keys in Notetaker settings.</p>` : ""}
            <button type="button" class="btn secondary block" id="open-notes">Open notes</button>
            <button type="button" class="btn secondary block" id="dismiss">Hide and keep going</button>
          </div>`;
    case "done":
      return `
          <div class="stack">
            <div><h2>Your notes are ready</h2><p class="sub">${escapeHtml(ctx.state?.latest?.title ?? "")}</p></div>
            <button type="button" class="btn primary block" id="open-notes">Open notes</button>
            <button type="button" class="btn secondary block" id="dismiss">Dismiss</button>
          </div>`;
    case "error":
      return renderError(ctx);
    case "recording":
      return `
          <div class="stack">
            <div class="transcript-wrap">
              <div class="transcript" id="transcript" role="log" aria-live="off" aria-label="Live transcript" tabindex="0"></div>
              <button type="button" class="jump" id="jump" hidden>Jump to latest</button>
            </div>
            <form class="row" id="moment-form" autocomplete="off">
              <input type="text" id="moment-note" maxlength="280" placeholder="Add a note to this moment" aria-label="Note for this moment (optional)" />
              <button type="submit" class="btn secondary" id="moment-submit">Flag</button>
            </form>
            <div id="moments-wrap" hidden><p class="section-label">Flagged moments</p><ul class="moments" id="moments"></ul></div>
            <button type="button" class="btn danger block" id="stop">Stop &amp; write notes</button>
          </div>`;
    default:
      return renderReady(ctx);
  }
}

function renderError(ctx: TemplateContext): string {
  const message = errorMessage(ctx);
  // A failed start can be retried here; a meeting that failed after the call can only be inspected.
  const retryable = ctx.ui.error !== null;
  const needsMic = message === MIC_PERMISSION_HINT;
  const shortcutHint =
    message === CAPTURE_PERMISSION_HINT && ctx.state?.shortcuts.toggle ? ` Or press ${keysHtml(ctx.state.shortcuts.toggle)} on this tab.` : "";
  return `
          <div class="stack">
            <div><h2>Couldn't take notes</h2></div>
            <p class="note error">${escapeHtml(message)}${shortcutHint}</p>
            <div class="row">
              ${needsMic ? `<button type="button" class="btn primary" id="allow-mic">Allow microphone</button>` : ""}
              ${retryable ? `<button type="button" class="btn ${needsMic ? "secondary" : "primary"}" id="retry">Try again</button>` : `<button type="button" class="btn primary" id="open-notes">Open details</button>`}
              <button type="button" class="btn secondary" id="dismiss">Dismiss</button>
            </div>
          </div>`;
}

function renderReady(ctx: TemplateContext): string {
  const { state } = ctx;
  const notice = helperNotice(state);
  const mode = ctx.selectedMode ?? state?.defaultMeetingMode ?? "general";
  const intro = state?.callTitle
    ? `Notes for <strong>${escapeHtml(state.callTitle)}</strong> appear right after the call.`
    : "Notes, decisions, and action items appear right after the call.";
  const shortcutLine = state?.shortcuts.toggle
    ? `<p class="sub">Start or stop with ${keysHtml(state.shortcuts.toggle)}</p>`
    : `<p class="sub">No keyboard shortcut is set. <button type="button" class="link" id="set-shortcut">Set one</button></p>`;
  return `
      <div class="stack">
        <div><h2>Ready when you are</h2><p class="sub">${intro}</p></div>
        ${
          notice
            ? `<p class="note warn" role="status" id="helper-note">${escapeHtml(notice)}</p>
               <div class="row"><button type="button" class="btn primary" id="helper-setup">Set up helper</button><button type="button" class="btn secondary" id="helper-check">Check again</button></div>`
            : ""
        }
        <div class="field">
          <label for="mode">Notes style</label>
          <select id="mode">${MODES.map(([value, label]) => `<option value="${value}"${value === mode ? " selected" : ""}>${label}</option>`).join("")}</select>
        </div>
        <p class="consent"><strong>Nobody else is notified.</strong> Tell everyone you're recording; some places require everyone's consent.</p>
        <button type="button" class="btn ${notice ? "secondary" : "primary"} block" id="start"${canStart(state) ? "" : ` disabled aria-describedby="helper-note"`}>Start taking notes</button>
        ${shortcutLine}
      </div>`;
}
