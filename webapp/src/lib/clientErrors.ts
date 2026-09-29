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

const ALLOWED_SURFACES = new Set(["meet_capture", "managed_upload", "managed_job", "popup", "widget", "settings", "onboarding", "meeting_view", "background"]);
const ALLOWED_ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "NotAllowedError", "NotFoundError", "NetworkError"]);

/** Generous per-user ceiling: a broken loop must not become a DoS on Sentry. */
export const clientErrorLimiter = createSlidingWindowLimiter({ limit: 20, windowMs: 60_000 });

export interface ClientErrorReport {
  message: string;
  surface: string;
  errorClass?: string;
  extensionVersion?: string;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.slice(0, max);
}

export function parseClientErrorReport(body: Record<string, unknown>): { ok: true; report: ClientErrorReport } | { ok: false; error: string } {
  const surface = boundedString(body.surface, 40);
  if (!surface || !ALLOWED_SURFACES.has(surface)) return { ok: false, error: "surface is not recognized" };
  // Never relay a caller-provided message, stack, meeting ID, or other
  // free-form value to telemetry. These often contain provider responses,
  // user prompts, transcript snippets, signed URLs, or tokens.
  const errorClass = boundedString(body.errorClass, 40);
  const extensionVersion = boundedString(body.extensionVersion, 40);
  return {
    ok: true,
    report: {
      message: `${surface} operation failed`,
      surface,
      ...(errorClass && ALLOWED_ERROR_CLASSES.has(errorClass) ? { errorClass } : {}),
      ...(extensionVersion && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(extensionVersion) ? { extensionVersion } : {}),
    },
  };
}

export function recordClientError(session: { userId: string; workspaceId: string; email: string }, body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const parsed = parseClientErrorReport(body);
  if (!parsed.ok) return parsed;
  const { report } = parsed;
  captureWarning(`extension error: ${report.message}`, {
    clientSurface: report.surface,
    errorClass: report.errorClass,
    extensionVersion: report.extensionVersion,
  });
  return { ok: true };
}
