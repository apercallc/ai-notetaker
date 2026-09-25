import type { ManagedServiceConfig } from "../types";

/**
 * Best-effort extension error reporting — Hosted AI mode only.
 *
 * The extension is the surface users live in, and its service worker is where
 * Meet capture, managed upload, and processing polls run. MV3 service workers
 * cannot run a full Sentry SDK usefully (no long-lived transport, aggressive
 * suspension), so critical failures are posted as one bounded JSON record to
 * the hosted service's authenticated /api/v1/client-errors endpoint.
 *
 * Privacy boundary: reportManagedError is a no-op unless a managed service
 * config is passed. Local BYOK mode never calls it, so free local use has no
 * telemetry whatsoever — consistent with SECURITY.md and docs/data-handling.md.
 */

const REPORT_TIMEOUT_MS = 8_000;
/** One in-flight/dedup window per key: a retry loop must not spam the service. */
const DEDUP_WINDOW_MS = 5 * 60_000;
const MAX_STACK_CHARS = 4_000;

const recentReports = new Map<string, number>();

export type ErrorSurface =
  | "meet_capture"
  | "managed_upload"
  | "managed_job"
  | "popup"
  | "widget"
  | "settings"
  | "onboarding"
  | "meeting_view"
  | "background";

interface ReportOptions {
  surface: ErrorSurface;
  /** Dedup key: `${surface}:${message}` when omitted. */
  key?: string;
  meetingId?: string;
  extensionVersion?: string;
  fetchImpl?: typeof fetch;
}

function stackOf(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack ?? error.message : String(error);
  return stack.slice(0, MAX_STACK_CHARS) || undefined;
}

/**
 * Fire-and-forget: the reporter must never delay or fail the user-facing
 * recovery path that calls it. Duplicate reports inside the dedup window are
 * dropped so a persistent failure surfaces once, not once per retry.
 */
export function reportManagedError(config: ManagedServiceConfig | null | undefined, error: unknown, options: ReportOptions): void {
  if (!config) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (!message) return;
  const key = options.key ?? `${options.surface}:${message}`;
  const now = Date.now();
  const last = recentReports.get(key) ?? 0;
  if (now - last < DEDUP_WINDOW_MS) return;
  recentReports.set(key, now);
  if (recentReports.size > 100) {
    for (const [mapKey, time] of recentReports) {
      if (now - time >= DEDUP_WINDOW_MS) recentReports.delete(mapKey);
    }
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  void fetchImpl(`${config.baseUrl}/api/v1/client-errors`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${config.accessToken}`,
      "X-Workspace-Id": config.workspaceId,
    },
    body: JSON.stringify({
      message,
      surface: options.surface,
      ...(stackOf(error) ? { stack: stackOf(error) } : {}),
      ...(options.meetingId ? { meetingId: options.meetingId } : {}),
      ...(options.extensionVersion ? { extensionVersion: options.extensionVersion } : {}),
    }),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}
