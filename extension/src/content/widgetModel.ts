import type { WidgetState } from "../lib/internalMessages";
import type { ErrorRecoveryCategory } from "../types";

export type WidgetView =
  | "disconnected"
  | "setup"
  | "ready"
  | "starting"
  | "recording"
  | "processing"
  | "done"
  | "error";

export interface WidgetUi {
  starting: boolean;
  error: string | null;
  errorRecovery?: ErrorRecoveryCategory;
  /** The finished meeting whose "notes ready" card the user already closed. */
  dismissedMeetingId: string | null;
  /** True once the extension was reloaded under this page; only a tab reload recovers. */
  contextLost: boolean;
  /** Latest retryable helper warning, shown while notes are still being written. */
  warning?: string | null;
}

/** How long a finished meeting keeps its "notes ready" card in the call tab. */
export const DONE_CARD_WINDOW_MS = 30 * 60_000;

export function deriveView(state: WidgetState | null, ui: WidgetUi, now: number = Date.now()): WidgetView {
  if (ui.contextLost || !state) return "disconnected";
  if (state.active?.status === "recording") return "recording";
  if (ui.starting) return "starting";
  if (ui.error) return "error";
  if (!state.onboardingComplete || !state.consentAcknowledged) return "setup";
  const latest = state.latest;
  if (latest && latest.id !== ui.dismissedMeetingId) {
    if (latest.status === "processing") return "processing";
    const endedAt = latest.endedAt ? Date.parse(latest.endedAt) : Date.parse(latest.startedAt);
    const recent = Number.isFinite(endedAt) && now - endedAt < DONE_CARD_WINDOW_MS;
    if (recent && latest.status === "complete") return "done";
    if (recent && latest.status === "error") return "error";
  }
  return "ready";
}

export function canStart(state: WidgetState | null): boolean {
  // The Meet widget is browser-owned capture. Desktop calls use the popup's
  // desktop-helper path, so a missing helper must not block Meet recording.
  return !!state?.onboardingComplete && !!state?.consentAcknowledged;
}

export function helperNotice(state: WidgetState | null): string | null {
  // Meet capture persists its own mic/speaker chunks in the extension and can
  // process them with BYOK or Hosted AI. The helper is only required for
  // desktop-call capture, which is not initiated from this Meet widget.
  if (state?.onboardingComplete && state.consentAcknowledged) return null;
  switch (state?.helperStatus) {
    case "connected":
      return null;
    case "connecting":
      return "Connecting to the desktop helper…";
    case "incompatible":
      return "The desktop helper needs an update before it can record.";
    default:
      return "The desktop helper isn't running. Start it, or set it up, to take notes.";
  }
}

export function formatElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  const totalSeconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
