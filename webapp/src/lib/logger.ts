import { captureServerError } from "./observability";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that stamps `bindings` (for example a request id) on every event. */
  child(bindings: LogContext): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Logs are shipped to a third-party aggregator in managed hosting. Anything
// that looks like a credential is replaced before serialization, whatever the
// caller passed. Transcript and prompt text should never reach a log call.
const SECRET_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|signature|bearer|dsn/i;
const MAX_DEPTH = 4;
const MAX_STRING = 500;
const MAX_ITEMS = 20;
const MAX_STACK_FRAMES = 10;

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

function jsonOutput(): boolean {
  const format = process.env.LOG_FORMAT?.trim().toLowerCase();
  return format ? format === "json" : process.env.NODE_ENV === "production";
}

function serializeError(error: Error): LogContext {
  return {
    name: error.name,
    message: clip(error.message),
    ...(error.stack ? { stack: error.stack.split("\n").slice(0, MAX_STACK_FRAMES + 1).join("\n") } : {}),
    ...(error.cause !== undefined ? { cause: sanitize(error.cause, 1, new WeakSet()) } : {}),
  };
}

function clip(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return clip(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return `[${typeof value}]`;
  }
  if (value instanceof Error) return depth > MAX_DEPTH ? "[error]" : serializeError(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth > MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`);
    return items;
  }
  const out: LogContext = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS * 2)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1, seen);
  }
  return out;
}

function baseFields(): LogContext {
  const release = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return {
    service: process.env.RAILWAY_SERVICE_NAME?.trim() || "webapp",
    ...(release ? { release: release.slice(0, 12) } : {}),
  };
}

function emit(level: LogLevel, message: string, bindings: LogContext, context: LogContext | undefined): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  const merged: LogContext = { ...bindings, ...context };
  // Accept either spelling; both are normalized to `error` so aggregators
  // index one field.
  const rawError = merged.error ?? merged.err;
  delete merged.err;
  const fields = sanitize(merged, 0, new WeakSet()) as LogContext;
  if (rawError !== undefined) fields.error = sanitize(rawError, 1, new WeakSet());

  const sink = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.info;
  const time = new Date().toISOString();
  if (jsonOutput()) {
    // Reserved fields are written last so a caller context key can't spoof them.
    sink(JSON.stringify({ ...fields, ...baseFields(), level, time, message }));
  } else {
    const detail = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    sink(`${time} ${level.toUpperCase().padEnd(5)} ${message}${detail}`);
  }

  // Only real Error objects are forwarded: Sentry's own privacy filter keeps
  // the stack and drops the text, and string-only failures stay in the logs.
  if (level === "error" && rawError instanceof Error) {
    const requestId = typeof merged.requestId === "string" ? merged.requestId : undefined;
    captureServerError(rawError, requestId ? { requestId } : {});
  }
}

function build(bindings: LogContext): Logger {
  return {
    debug: (message, context) => emit("debug", message, bindings, context),
    info: (message, context) => emit("info", message, bindings, context),
    warn: (message, context) => emit("warn", message, bindings, context),
    error: (message, context) => emit("error", message, bindings, context),
    child: (extra) => build({ ...bindings, ...extra }),
  };
}

export const logger: Logger = build({});
