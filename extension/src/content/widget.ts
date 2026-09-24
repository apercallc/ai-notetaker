import { formatOffset } from "../lib/bookmarks";
import { escapeHtml } from "../lib/html";
import type { BackgroundToUiMessage, UiToBackgroundMessage, WidgetMeeting, WidgetState } from "../lib/internalMessages";
import { speakerLabel, type MeetingMode, type Speaker } from "../types";
import { canStart, deriveView, formatElapsed, type WidgetUi, type WidgetView } from "./widgetModel";
import { ICONS, errorMessage, readyKey, renderPanel, renderPill, type TemplateContext } from "./widgetTemplates";

export interface WidgetDeps {
  /** Sends a message to the background worker; rejects if the extension context is gone. */
  send: <T = unknown>(message: UiToBackgroundMessage) => Promise<T>;
  /** Meeting title suggested from the tab, used when no calendar event names the call. */
  titleHint: () => string | undefined;
  reload: () => void;
  styles?: string;
  now?: () => number;
  /** Tests use "open" to reach into the shadow root; production always uses "closed". */
  shadowMode?: "open" | "closed";
}

export interface Position {
  x: number;
  y: number;
}

const HOST_ID = "ai-notetaker-widget-host";
const MAX_TRANSCRIPT_LINES = 200;
const MAX_VISIBLE_MOMENTS = 5;
const DRAG_THRESHOLD_PX = 4;
const DEFAULT_POSITION: Position = { x: 16, y: 72 };
const CONTEXT_LOST = /context invalidated|receiving end does not exist|message port closed/i;

/**
 * The floating notes widget for a Google Meet call. Owns one closed shadow
 * root on the page and nothing else: it reads no Meet markup and holds no
 * secrets. All state lives in the background worker; this only renders it.
 */
export class MeetWidget {
  private readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly root: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly status: HTMLElement;
  private state: WidgetState | null = null;
  private ui: WidgetUi = { starting: false, error: null, dismissedMeetingId: null, contextLost: false };
  private view: WidgetView | null = null;
  private expanded = false;
  private position: Position = DEFAULT_POSITION;
  private timer: number | null = null;
  private toastTimer: number | null = null;
  private stopArmedTimer: number | null = null;
  private announceTimer: number | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private pinnedToBottom = true;
  private selectedMode: MeetingMode | null = null;
  private noteDraft = "";
  private pendingToast: string | null = null;
  private renderedReadyKey = "";
  private positionRestored = false;
  private endDrag: (() => void) | null = null;
  private destroyed = false;
  private readonly onResize = (): void => this.applyPosition();

  constructor(
    private readonly deps: WidgetDeps,
    private readonly doc: Document = document,
  ) {
    this.host = doc.createElement("div");
    this.host.id = HOST_ID;
    Object.assign(this.host.style, { position: "fixed", zIndex: "2147483000", left: "0", top: "0" });
    const shadow = this.host.attachShadow({ mode: deps.shadowMode ?? "closed" });
    this.shadow = shadow;
    const style = doc.createElement("style");
    style.textContent = deps.styles ?? "";
    this.root = doc.createElement("div");
    this.root.className = "nt";
    this.toast = doc.createElement("div");
    this.toast.className = "toast";
    this.toast.setAttribute("aria-hidden", "true");
    // One live region that is never re-rendered: a region that is removed and
    // re-added does not reliably announce, and the transcript itself must not
    // be read out over the call.
    this.status = doc.createElement("div");
    this.status.className = "sr-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    shadow.append(style, this.root, this.status);
    // Meet binds single-key shortcuts (c, m, e…) on the document; typing a note
    // must never toggle captions or the microphone.
    for (const type of ["keydown", "keyup", "keypress"] as const) {
      this.host.addEventListener(type, (event) => event.stopPropagation());
    }
    // Bound once: the panel's children are replaced on render, this root is not.
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.expanded) {
        this.setExpanded(false);
        this.root.querySelector<HTMLElement>("#toggle")?.focus();
      }
    });
  }

  get element(): HTMLElement {
    return this.host;
  }

  async mount(): Promise<void> {
    this.doc.documentElement.append(this.host);
    this.applyPosition();
    window.addEventListener("resize", this.onResize);
    await this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopTimer();
    this.endDrag?.();
    for (const timer of [this.stopArmedTimer, this.announceTimer, this.toastTimer]) if (timer !== null) window.clearTimeout(timer);
    window.removeEventListener("resize", this.onResize);
    this.host.remove();
  }

  handleMessage(message: BackgroundToUiMessage): void {
    switch (message.type) {
      case "TRANSCRIPT_UPDATE":
        if (this.state?.active?.id === message.meetingId) {
          this.upsertTranscriptLine(message.speaker, message.text, message.isFinal, message.utteranceId);
        }
        return;
      case "RECORDING_ERROR":
        // A helper problem that arrives while nobody asked to record (for
        // example a pairing failure at connect time) belongs in the helper
        // status, not in a "couldn't take notes" card.
        if (message.meetingId !== null || this.ui.starting || this.state?.active) {
          this.ui = { ...this.ui, starting: false, error: message.message };
        }
        void this.refresh();
        return;
      case "SUMMARY_READY":
      case "MEETING_STATE_CHANGED":
      case "HELPER_STATUS":
        void this.refresh();
        return;
      case "PROCESSING_WARNING":
        this.ui = { ...this.ui, warning: message.message };
        this.showToast("A transcription chunk will be retried automatically.");
        if (this.view === "processing") this.renderView();
        return;
      default:
        return;
    }
  }

  /** Re-reads background state. Concurrent calls collapse into one trailing refresh. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      try {
        this.state = await this.deps.send<WidgetState>({ type: "GET_WIDGET_STATE" });
        this.ui = { ...this.ui, contextLost: false };
      } catch (error) {
        if (error instanceof Error && CONTEXT_LOST.test(error.message)) this.ui = { ...this.ui, contextLost: true };
        else this.state = null;
      }
      this.render();
    })().finally(() => {
      this.refreshInFlight = null;
      if (this.refreshQueued && !this.destroyed) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    return this.refreshInFlight;
  }

  // ---------- rendering ----------

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private templateContext(): TemplateContext {
    return { state: this.state, ui: this.ui, expanded: this.expanded, now: this.now(), selectedMode: this.selectedMode };
  }

  private render(): void {
    if (this.destroyed) return;
    if (this.state && !this.state.widgetEnabled) {
      this.host.style.display = "none";
      return;
    }
    this.host.style.display = "";
    if (!this.positionRestored && this.state) {
      this.positionRestored = true;
      if (this.state.position) {
        this.position = this.state.position;
        this.applyPosition();
      }
    }
    const next = deriveView(this.state, this.ui, this.now());
    if (next !== this.view) {
      const previous = this.view;
      this.view = next;
      // Recording is the one state that must be visible at a glance; a
      // finished/failed call is worth opening the panel for as well.
      if (next === "recording" && previous !== "recording") {
        this.expanded = false;
        this.pendingToast = "Recording started. Let everyone know.";
      }
      if (next === "processing" && previous !== null) this.announce("Writing your notes");
      if (next === "done" && previous !== null) this.announce("Your notes are ready");
      if (next === "error" && previous !== null) this.announce(errorMessage(this.templateContext()));
      if ((next === "done" || next === "error" || next === "disconnected") && previous !== null) this.expanded = true;
      this.renderView();
    } else {
      this.patchView();
    }
  }

  private renderView(): void {
    const view = this.view!;
    const hadFocus = this.shadow.activeElement !== null;
    this.root.dataset.view = view;
    this.root.dataset.expanded = String(this.expanded);
    this.root.replaceChildren();
    const ctx = this.templateContext();
    this.root.insertAdjacentHTML("beforeend", renderPill(view, ctx));
    this.root.insertAdjacentHTML("beforeend", `<section class="panel" id="panel" aria-label="Notes panel">${renderPanel(view, ctx)}</section>`);
    this.root.append(this.toast);
    this.renderedReadyKey = readyKey(this.state);
    this.bindCommon();
    this.bindView(view);
    this.applyPlacement();
    if (view === "recording") this.startTimer();
    else this.stopTimer();
    if (view === "recording") this.patchRecording(true);
    // Re-rendering replaces the focused control; keep keyboard users in the widget.
    if (hadFocus) this.root.querySelector<HTMLElement>("#toggle")?.focus();
    if (this.pendingToast) {
      this.showToast(this.pendingToast);
      this.pendingToast = null;
    }
  }

  private patchView(): void {
    if (this.view === "recording") this.patchRecording(false);
    else if (this.view === "ready" || this.view === "setup") this.patchReady();
  }

  private patchReady(): void {
    if (readyKey(this.state) !== this.renderedReadyKey) this.renderView();
  }

  private patchRecording(initial: boolean): void {
    const active = this.state?.active;
    if (!active) return;
    const transcript = this.root.querySelector<HTMLElement>("#transcript");
    if (transcript) {
      // Rebuilding from the authoritative state also heals any live update that
      // raced with the refresh that produced it.
      const previousScroll = transcript.scrollTop;
      transcript.replaceChildren();
      if (active.transcript.length === 0) {
        transcript.insertAdjacentHTML("beforeend", `<p class="empty">Listening… the transcript appears here within a few seconds.</p>`);
      }
      for (const segment of active.transcript) this.upsertTranscriptLine(segment.speaker, segment.text, segment.isFinal, segment.utteranceId, true);
      transcript.scrollTop = initial || this.pinnedToBottom ? transcript.scrollHeight : previousScroll;
    }
    this.renderMoments(active);
  }

  private renderMoments(active: WidgetMeeting): void {
    const wrap = this.root.querySelector<HTMLElement>("#moments-wrap");
    const list = this.root.querySelector<HTMLElement>("#moments");
    if (!wrap || !list) return;
    wrap.hidden = active.bookmarks.length === 0;
    const recent = [...active.bookmarks].reverse();
    const shown = recent.slice(0, MAX_VISIBLE_MOMENTS);
    list.innerHTML =
      shown
        .map(
          (bookmark) =>
            `<li><span class="at">${formatOffset(bookmark.offsetMs)}</span><span class="what">${bookmark.note ? escapeHtml(bookmark.note) : "Flagged moment"}</span></li>`,
        )
        .join("") +
      (recent.length > shown.length ? `<li><span class="what">+${recent.length - shown.length} earlier</span></li>` : "");
  }

  private upsertTranscriptLine(speaker: Speaker, text: string, isFinal: boolean, utteranceId: number | undefined, silent = false): void {
    const container = this.root.querySelector<HTMLElement>("#transcript");
    if (!container) return;
    container.querySelector(".empty")?.remove();
    const key = utteranceId === undefined ? null : `${speaker}:${utteranceId}`;
    const existing = key ? (Array.from(container.children) as HTMLElement[]).find((child) => child.dataset.key === key) ?? null : null;
    const line = existing ?? this.doc.createElement("p");
    line.className = isFinal ? "line" : "line provisional";
    line.dataset.speaker = speaker === "you" ? "you" : "them";
    if (key && !isFinal) line.dataset.key = key;
    else line.removeAttribute("data-key");
    line.innerHTML = `<span class="who">${escapeHtml(speakerLabel(speaker))}</span><span class="txt">${escapeHtml(text)}</span>`;
    if (!existing) container.append(line);
    while (container.childElementCount > MAX_TRANSCRIPT_LINES) container.firstElementChild?.remove();
    if (silent) return;
    if (this.pinnedToBottom) container.scrollTop = container.scrollHeight;
    else this.root.querySelector<HTMLElement>("#jump")?.removeAttribute("hidden");
  }

  // ---------- events ----------

  private bindCommon(): void {
    this.root.querySelector("#toggle")?.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.root.querySelector("#chevron")?.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.bindDrag();
  }

  private bindView(view: WidgetView): void {
    const on = (selector: string, handler: () => void): void => {
      this.root.querySelector(selector)?.addEventListener("click", handler);
    };
    on("#reload", () => this.deps.reload());
    const openPage = (page: "onboarding" | "shortcuts" | "microphone" | "install"): void => {
      void this.deps.send({ type: "OPEN_PAGE", page }).catch(() => {});
    };
    on("#open-setup", () => openPage("onboarding"));
    on("#set-shortcut", () => openPage("shortcuts"));
    on("#allow-mic", () => openPage("microphone"));
    on("#helper-setup", () => openPage("install"));
    on("#helper-check", () => void this.deps.send({ type: "CHECK_HELPER" }).then(() => this.refresh()).catch(() => {}));
    on("#open-notes", () => {
      const id = this.state?.latest?.id;
      if (id) void this.deps.send({ type: "OPEN_MEETING", meetingId: id }).catch(() => {});
    });
    on("#dismiss", () => {
      this.ui = { ...this.ui, error: null, dismissedMeetingId: this.state?.latest?.id ?? this.ui.dismissedMeetingId };
      this.expanded = false;
      this.render();
    });
    on("#retry", () => {
      this.ui = { ...this.ui, error: null };
      this.render();
      if (canStart(this.state)) void this.start();
    });
    on("#start", () => void this.start());
    on("#pill-start", () => void this.start());
    on("#stop", () => void this.stop());
    on("#pill-stop", () => this.confirmStop());
    on("#pill-bookmark", () => void this.flagMoment(""));
    this.root.querySelector<HTMLSelectElement>("#mode")?.addEventListener("change", (event) => {
      this.selectedMode = (event.target as HTMLSelectElement).value as MeetingMode;
    });
    if (view === "recording") {
      const transcript = this.root.querySelector<HTMLElement>("#transcript");
      transcript?.addEventListener("scroll", () => {
        this.pinnedToBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
        if (this.pinnedToBottom) this.root.querySelector<HTMLElement>("#jump")?.setAttribute("hidden", "");
      });
      this.root.querySelector("#jump")?.addEventListener("click", () => {
        if (!transcript) return;
        transcript.scrollTop = transcript.scrollHeight;
      });
      const input = this.root.querySelector<HTMLInputElement>("#moment-note");
      if (input) {
        input.value = this.noteDraft;
        input.addEventListener("input", () => {
          this.noteDraft = input.value;
        });
      }
      this.root.querySelector("#moment-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.flagMoment(input?.value ?? "");
      });
    }
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.root.dataset.expanded = String(expanded);
    this.root.querySelector("#toggle")?.setAttribute("aria-expanded", String(expanded));
    this.root.querySelector("#chevron")?.setAttribute("aria-label", expanded ? "Collapse notes panel" : "Expand notes panel");
    this.applyPlacement();
    if (expanded && this.view === "recording") {
      const transcript = this.root.querySelector<HTMLElement>("#transcript");
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    }
  }

  // ---------- actions ----------

  private async start(): Promise<void> {
    if (!canStart(this.state) || this.ui.starting) return;
    this.ui = { ...this.ui, starting: true, error: null, warning: null };
    this.render();
    const titleHint = this.deps.titleHint();
    const mode = this.selectedMode ?? this.state?.defaultMeetingMode ?? "general";
    try {
      const response = await this.deps.send<{ meetingId?: string }>({
        type: "START_RECORDING",
        captureSource: "meet",
        meetingMode: mode,
        ...(titleHint ? { titleHint } : {}),
      });
      this.ui = { ...this.ui, starting: false };
      if (!response?.meetingId && !this.ui.error) {
        this.ui = { ...this.ui, error: "Recording could not start. Check that the desktop helper is running, then try again." };
      }
      this.pinnedToBottom = true;
      this.noteDraft = "";
    } catch (error) {
      this.ui = {
        ...this.ui,
        starting: false,
        ...(error instanceof Error && CONTEXT_LOST.test(error.message) ? { contextLost: true } : { error: "Recording could not start. Try again." }),
      };
    }
    await this.refresh();
  }

  /** The pill's stop sits beside the flag button and ends the recording, so it asks once. */
  private confirmStop(): void {
    const button = this.root.querySelector<HTMLButtonElement>("#pill-stop");
    if (!button) return;
    if (this.stopArmedTimer !== null) {
      window.clearTimeout(this.stopArmedTimer);
      this.stopArmedTimer = null;
      void this.stop();
      return;
    }
    button.classList.add("armed");
    button.setAttribute("aria-label", "Confirm: stop recording and write notes");
    button.textContent = "Stop?";
    this.announce("Press stop again to end the recording and write your notes");
    this.stopArmedTimer = window.setTimeout(() => {
      this.stopArmedTimer = null;
      button.classList.remove("armed");
      button.setAttribute("aria-label", "Stop recording and write notes");
      button.innerHTML = ICONS.stop;
    }, 3000);
  }

  private async stop(): Promise<void> {
    const id = this.state?.active?.id;
    if (!id) return;
    this.ui = { ...this.ui, dismissedMeetingId: null };
    try {
      await this.deps.send({ type: "STOP_RECORDING", meetingId: id });
    } catch {
      this.ui = { ...this.ui, error: "Stopping could not be confirmed. Your audio is safe. Click the Notetaker icon in the Chrome toolbar to check on it." };
    }
    this.expanded = true;
    await this.refresh();
  }

  private async flagMoment(note: string): Promise<void> {
    const active = this.state?.active;
    if (!active) return;
    try {
      const response = await this.deps.send<{ ok?: boolean }>({ type: "ADD_BOOKMARK", meetingId: active.id, note });
      if (response?.ok === false) {
        this.showToast("This moment couldn't be flagged");
        return;
      }
      this.noteDraft = "";
      const input = this.root.querySelector<HTMLInputElement>("#moment-note");
      if (input) input.value = "";
      this.showToast(`Moment flagged at ${formatElapsed(active.startedAt, this.now())}`);
      await this.refresh();
    } catch {
      this.showToast("This moment couldn't be flagged");
    }
  }

  private announce(text: string): void {
    // Clearing first makes a repeated message announce again.
    this.status.textContent = "";
    if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => {
      this.status.textContent = text;
    }, 30);
  }

  private showToast(text: string): void {
    this.announce(text);
    this.toast.textContent = text;
    this.toast.classList.add("show");
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove("show"), 2500);
  }

  // ---------- timer ----------

  private startTimer(): void {
    this.stopTimer();
    this.timer = window.setInterval(() => {
      const active = this.state?.active;
      const el = this.root.querySelector<HTMLElement>("#elapsed");
      if (active && el) el.textContent = formatElapsed(active.startedAt, this.now());
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- placement & dragging ----------

  private clamp(position: Position): Position {
    const margin = 8;
    const width = this.root.querySelector<HTMLElement>(".pill")?.offsetWidth || 140;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - 48 - margin);
    return {
      x: Math.min(Math.max(margin, position.x), maxX),
      y: Math.min(Math.max(margin, position.y), maxY),
    };
  }

  private applyPosition(): void {
    this.position = this.clamp(this.position);
    this.host.style.transform = `translate(${this.position.x}px, ${this.position.y}px)`;
    this.applyPlacement();
  }

  /** Opens the panel toward the side of the screen with more room. */
  private applyPlacement(): void {
    this.root.dataset.side = this.position.y > window.innerHeight / 2 ? "above" : "below";
    this.root.dataset.align = this.position.x > window.innerWidth / 2 ? "right" : "left";
  }

  private savePosition(): void {
    void this.deps.send({ type: "SAVE_WIDGET_POSITION", position: this.position }).catch(() => {});
  }

  private bindDrag(): void {
    const pill = this.root.querySelector<HTMLElement>(".pill");
    if (!pill) return;
    let origin: { pointerX: number; pointerY: number; x: number; y: number } | null = null;
    let dragged = false;

    // Move and release are listened for on the window for the length of a press.
    // A quick flick leaves the pill before its first move event, and capturing
    // the pointer would retarget the click away from the buttons inside it.
    const onMove = (event: PointerEvent): void => {
      if (!origin) return;
      const dx = event.clientX - origin.pointerX;
      const dy = event.clientY - origin.pointerY;
      if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragged = true;
      pill.classList.add("dragging");
      this.position = this.clamp({ x: origin.x + dx, y: origin.y + dy });
      this.applyPosition();
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      this.endDrag = null;
      if (!origin) return;
      origin = null;
      pill.classList.remove("dragging");
      if (dragged) this.savePosition();
    };

    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      origin = { pointerX: event.clientX, pointerY: event.clientY, x: this.position.x, y: this.position.y };
      dragged = false;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      this.endDrag = finish;
    });
    pill.addEventListener("keydown", (event) => {
      const arrows: Record<string, Position> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      const direction = arrows[event.key];
      if (!direction || (event.target as HTMLElement).id !== "toggle") return;
      event.preventDefault();
      const step = event.shiftKey ? 64 : 16;
      this.position = this.clamp({ x: this.position.x + direction.x * step, y: this.position.y + direction.y * step });
      this.applyPosition();
      this.savePosition();
    });
    // A drag that ends over a button must not also click it.
    pill.addEventListener(
      "click",
      (event) => {
        if (dragged) {
          event.stopImmediatePropagation();
          event.preventDefault();
          dragged = false;
        }
      },
      true,
    );
  }
}
