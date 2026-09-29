import { pathToFileURL } from "node:url";

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_ERROR_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const SAFE_ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "ManagedWorkerRequestError"]);
const SAFE_WORKER_PHASES = new Set(["poll", "fatal"]);

function safeWorkerSentryEvent(event) {
  const tags = {};
  const allowedTags = ["workerPhase", "errorClass", "httpStatus"];
  for (const key of allowedTags) {
    const value = event.tags?.[key];
    if (typeof value !== "string") continue;
    if (key === "workerPhase" && SAFE_WORKER_PHASES.has(value)) tags[key] = value;
    else if (key === "errorClass" && SAFE_ERROR_CLASSES.has(value)) tags[key] = value;
    else if (key === "httpStatus" && /^\d{3}$/.test(value) && Number(value) >= 100 && Number(value) <= 599) tags[key] = value;
  }
  return {
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.platform ? { platform: event.platform } : {}),
    ...(event.level ? { level: event.level } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    ...(event.release ? { release: event.release } : {}),
    ...(Object.keys(tags).length ? { tags } : {}),
    ...(event.exception?.values?.length
      ? { exception: { values: event.exception.values.map((item) => ({ type: SAFE_ERROR_CLASSES.has(item.type) ? item.type : "Error", value: "Managed worker failure" })) } }
      : {}),
    ...(event.message ? { message: "Managed worker failure" } : {}),
  };
}

// Sentry (DSN-gated): the worker is the process that turns uploaded audio
// into notes, so its crashes and provider failures are the highest-signal
// errors the service can capture. No DSN → no init, no outbound call.
let sentry = null;
if (process.env.SENTRY_DSN?.trim()) {
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN.trim(),
      environment: process.env.SENTRY_ENVIRONMENT?.trim() || "managed-worker",
      ...(process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ? { release: process.env.RAILWAY_GIT_COMMIT_SHA.trim() } : {}),
      beforeSend: safeWorkerSentryEvent,
      beforeBreadcrumb: () => null,
    });
    sentry = Sentry;
  } catch {
    // The worker must keep running even if error reporting cannot load.
  }
}

export function reportWorkerError(error, context = {}) {
  if (!sentry) return;
  try {
    const rawName = error instanceof Error ? error.name : "Error";
    const errorClass = SAFE_ERROR_CLASSES.has(rawName) ? rawName : "Error";
    const workerPhase = SAFE_WORKER_PHASES.has(context.phase) ? context.phase : undefined;
    const status = error instanceof ManagedWorkerRequestError ? error.status : undefined;
    const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : undefined;
    const tags = {
      ...(workerPhase ? { workerPhase } : {}),
      errorClass,
      ...(httpStatus ? { httpStatus } : {}),
    };
    // Do not hand Sentry the original error or context: messages and stacks
    // can contain provider payloads, server response bodies, URLs, or secrets.
    sentry.captureException({ name: errorClass, message: workerPhase ? `Managed worker ${workerPhase} failure` : "Managed worker failure" }, { tags });
  } catch {
    // never on the failure path
  }
}

export async function reportAndFlush(error, context = {}) {
  reportWorkerError(error, context);
  if (!sentry) return;
  try {
    await sentry.flush(2_000);
  } catch {
    // best effort
  }
}

export class ManagedWorkerRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ManagedWorkerRequestError";
    this.status = status;
  }
}

function boundedMilliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), 250), MAX_BACKOFF_MS) : fallback;
}

export function workerConfig(env = process.env) {
  const baseUrl = env.MANAGED_WORKER_WEBAPP_URL?.trim() || "http://webapp:3000";
  const token = env.MANAGED_WORKER_TOKEN?.trim();
  if (!token) throw new Error("MANAGED_WORKER_TOKEN is required for the managed worker");
  return {
    baseUrl,
    token,
    pollMs: boundedMilliseconds(env.MANAGED_WORKER_POLL_MS, DEFAULT_POLL_MS),
    errorBackoffMs: boundedMilliseconds(env.MANAGED_WORKER_ERROR_BACKOFF_MS, DEFAULT_ERROR_BACKOFF_MS),
  };
}

export function nextErrorDelay(previousDelay, minimumDelay) {
  return Math.min(Math.max(previousDelay * 2, minimumDelay), MAX_BACKOFF_MS);
}

export async function pollOnce({ baseUrl, token, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL("/api/v1/jobs/next", baseUrl).toString(), {
    method: "POST",
    headers: { "x-worker-token": token },
  });
  if (response.status === 204) return { status: "idle" };
  const bodyText = await response.text();
  if (!response.ok) {
    throw new ManagedWorkerRequestError(`worker endpoint returned ${response.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, response.status);
  }
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new ManagedWorkerRequestError("worker endpoint returned invalid JSON", response.status);
    }
  }
  return { status: "processed", body };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runManagedWorker({ config = workerConfig(), fetchImpl = fetch, log = console } = {}) {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  log.info?.("managed worker started", { pollMs: config.pollMs });

  let delay = config.pollMs;
  let idleLogged = false;
  try {
    while (!stopping) {
      try {
        const result = await pollOnce({ baseUrl: config.baseUrl, token: config.token, fetchImpl });
        if (result.status === "processed") {
          log.info?.("managed job processed", result.body ?? {});
          idleLogged = false;
        } else if (!idleLogged) {
          log.info?.("managed worker idle");
          idleLogged = true;
        }
        delay = config.pollMs;
      } catch (error) {
        if (error instanceof ManagedWorkerRequestError && error.status === 401) throw error;
        log.error?.("managed worker poll failed; retrying", error instanceof Error ? error.message : String(error));
        reportWorkerError(error, { phase: "poll" });
        delay = nextErrorDelay(delay, config.errorBackoffMs);
      }
      if (!stopping) await sleep(delay);
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runManagedWorker();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await reportAndFlush(error, { phase: "fatal" });
    process.exitCode = 1;
  }
}
