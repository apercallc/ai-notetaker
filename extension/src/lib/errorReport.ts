import type { ManagedServiceConfig } from "../types";
import { serviceUrl } from "./managedClient";

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
const SAFE_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "NotAllowedError", "NotFoundError", "NetworkError"]);

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

function safeErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return SAFE_ERROR_NAMES.has(name) ? name : "Error";
}

/**
 * Fire-and-forget: the reporter must never delay or fail the user-facing
 * recovery path that calls it. Duplicate reports inside the dedup window are
 * dropped so a persistent failure surfaces once, not once per retry.
 */
export function reportManagedError(config: ManagedServiceConfig | null | undefined, error: unknown, options: ReportOptions): void {
  if (!config) return;
  // Provider messages and stacks frequently contain prompts, transcript
  // excerpts, signed URLs, or credentials. Keep those values local; only send
  // a stable failure label and built-in error class to the managed service.
  const errorClass = safeErrorClass(error);
  const message = `${options.surface} operation failed`;
  const key = options.key ?? `${options.surface}:${errorClass}`;
  const now = Date.now();
  const last = recentReports.get(key) ?? 0;
  if (now - last < DEDUP_WINDOW_MS) return;
  recentReports.set(key, now);
  if (recentReports.size > 100) {
    for (const [mapKey, time] of recentReports) {
      if (now - time >= DEDUP_WINDOW_MS) recentReports.delete(mapKey);
    }
  }
  // Reports carry the bearer token: never send them to a URL that is not a
  // valid managed-service origin (corrupted or tampered stored settings).
  let endpoint: string;
  try {
    endpoint = `${serviceUrl(config.baseUrl)}/api/v1/client-errors`;
  } catch {
    return;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  void fetchImpl(endpoint, {
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
      errorClass,
      ...(options.extensionVersion && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(options.extensionVersion)
        ? { extensionVersion: options.extensionVersion }
        : {}),
    }),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}
