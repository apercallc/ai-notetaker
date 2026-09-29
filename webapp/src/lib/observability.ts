import * as Sentry from "@sentry/nextjs";

const SAFE_ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "NotAllowedError", "NotFoundError", "NetworkError"]);
const SAFE_SURFACES = new Set(["meet_capture", "managed_upload", "managed_job", "popup", "widget", "settings", "onboarding", "meeting_view", "background"]);
const SAFE_TAGS = new Set(["clientSurface", "errorClass", "extensionVersion"]);

/**
 * Last-chance privacy filter applied to every web Sentry event. Exception
 * text, request data, user identity, breadcrumbs, and arbitrary extras can
 * contain prompts, transcript text, provider payloads, URLs, or credentials.
 * Keep only stack locations and a small set of bounded diagnostic labels.
 */
export function redactSentryEvent<T extends Sentry.Event>(event: T): T {
  const safe: Sentry.Event = {};
  for (const key of ["event_id", "timestamp", "platform", "level", "environment", "release", "logger"] as const) {
    if (event[key] !== undefined) safe[key] = event[key] as never;
  }

  const tags: Record<string, string> = {};
  for (const key of SAFE_TAGS) {
    const value = event.tags?.[key];
    if (typeof value !== "string") continue;
    if (key === "clientSurface" && SAFE_SURFACES.has(value)) tags[key] = value;
    else if (key === "errorClass" && SAFE_ERROR_TYPES.has(value)) tags[key] = value;
    else if (key === "extensionVersion" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)) tags[key] = value;
  }
  if (Object.keys(tags).length) safe.tags = tags;

  if (event.exception?.values?.length) {
    safe.exception = {
      values: event.exception.values.map((exception) => {
        const type = exception.type && SAFE_ERROR_TYPES.has(exception.type) ? exception.type : "Error";
        return {
          type,
          value: "[redacted error details]",
          ...(exception.stacktrace?.frames
            ? {
                stacktrace: {
                  frames: exception.stacktrace.frames.map((frame) => ({
                    ...(frame.filename ? { filename: frame.filename } : {}),
                    ...(frame.function ? { function: frame.function } : {}),
                    ...(frame.lineno ? { lineno: frame.lineno } : {}),
                    ...(frame.colno ? { colno: frame.colno } : {}),
                    ...(frame.in_app !== undefined ? { in_app: frame.in_app } : {}),
                  })),
                },
              }
            : {}),
        };
      }),
    };
  }
  if (event.message) safe.message = "[redacted error details]";
  return safe as T;
}

/**
 * Error reporting is strictly DSN-gated: with no SENTRY_DSN configured (every
 * self-hosted and local deployment by default) nothing initializes, nothing
 * is captured, and no outbound request is ever made. This mirrors the
 * documented privacy boundary: local BYOK is a complete product path with no
 * telemetry; the project-operated managed service opts in via environment
 * configuration only.
 */
export function sentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN?.trim());
}

export function captureServerError(error: unknown, context: Record<string, unknown> = {}): void {
  if (!sentryEnabled() || !Sentry.isInitialized?.()) return;
  try {
    Sentry.captureException(error, { extra: { ...context } });
  } catch {
    // Reporting must never be on the failure path of the request it observes.
  }
}

export function captureWarning(message: string, context: Record<string, unknown> = {}): void {
  if (!sentryEnabled() || !Sentry.isInitialized?.()) return;
  try {
    Sentry.withScope((scope) => {
      scope.setLevel("warning");
      // Warning labels are controlled, structured values only. Free-form
      // error/context data stays local even if a future caller passes it.
      for (const [key, value] of Object.entries(context)) {
        if (key === "clientSurface" && typeof value === "string" && SAFE_SURFACES.has(value)) scope.setTag(key, value);
        else if (key === "errorClass" && typeof value === "string" && SAFE_ERROR_TYPES.has(value)) scope.setTag(key, value);
        else if (key === "extensionVersion" && typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)) scope.setTag(key, value);
        else if (key === "attempt" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) scope.setExtra(key, value);
      }
      Sentry.captureMessage(message);
    });
  } catch {
    // see captureServerError
  }
}

/** Stripped onto the configured capture scope, never onto the event itself. */
export function setCaptureContext(tags: Record<string, string>): void {
  if (!sentryEnabled()) return;
  try {
    for (const [key, value] of Object.entries(tags)) Sentry.setTag?.(key, value);
  } catch {
    // see captureServerError
  }
}

export function sentryRelease(): string | undefined {
  return process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined;
}
