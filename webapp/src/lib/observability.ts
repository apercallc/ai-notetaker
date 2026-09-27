import * as Sentry from "@sentry/nextjs";

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
      for (const [key, value] of Object.entries(context)) scope.setExtra(key, value);
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
