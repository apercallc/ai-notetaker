import { captureWarning } from "./observability";
import { createSlidingWindowLimiter } from "./lookupThrottle";

/**
 * Server-side handling of extension-reported errors (Hosted AI mode only).
 * The extension's service worker is where Meet capture lives, so its failure
 * modes (capture teardown, managed upload, processing poll) are exactly the
 * ones users cannot self-diagnose. Reports are bounded, stripped of free-form
 * content beyond a short message, and routed to Sentry as warnings tagged
 * with the reporting surface.
 */

const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 4_000;
const ALLOWED_SURFACES = new Set(["meet_capture", "managed_upload", "managed_job", "popup", "widget", "settings", "onboarding", "meeting_view", "background"]);

/** Generous per-user ceiling: a broken loop must not become a DoS on Sentry. */
export const clientErrorLimiter = createSlidingWindowLimiter({ limit: 20, windowMs: 60_000 });

export interface ClientErrorReport {
  message: string;
  surface: string;
  stack?: string;
  meetingId?: string;
  extensionVersion?: string;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.slice(0, max);
}

export function parseClientErrorReport(body: Record<string, unknown>): { ok: true; report: ClientErrorReport } | { ok: false; error: string } {
  const message = boundedString(body.message, MAX_MESSAGE_CHARS);
  if (!message) return { ok: false, error: "message is required" };
  const surface = boundedString(body.surface, 40);
  if (!surface || !ALLOWED_SURFACES.has(surface)) return { ok: false, error: "surface is not recognized" };
  return {
    ok: true,
    report: {
      message,
      surface,
      ...(boundedString(body.stack, MAX_STACK_CHARS) ? { stack: boundedString(body.stack, MAX_STACK_CHARS) } : {}),
      ...(boundedString(body.meetingId, 128) ? { meetingId: boundedString(body.meetingId, 128) } : {}),
      ...(boundedString(body.extensionVersion, 40) ? { extensionVersion: boundedString(body.extensionVersion, 40) } : {}),
    },
  };
}

export function recordClientError(session: { userId: string; workspaceId: string; email: string }, body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const parsed = parseClientErrorReport(body);
  if (!parsed.ok) return parsed;
  const { report } = parsed;
  captureWarning(`extension error: ${report.message}`, {
    clientSurface: report.surface,
    meetingId: report.meetingId,
    extensionVersion: report.extensionVersion,
    // The stack is diagnostic, not user content; keep it out of the tagged
    // summary but attach it so the Sentry event groups by real stack frames.
    stack: report.stack,
    workspaceId: session.workspaceId,
  });
  return { ok: true };
}
