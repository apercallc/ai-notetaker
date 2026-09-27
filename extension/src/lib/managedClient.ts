import type { ActionItem, BrowserAudioChannel, ManagedEntitlements, ManagedServiceConfig, MeetingRecord } from "../types";

export interface ManagedLoginResult {
  config: ManagedServiceConfig;
  expiresAt: string;
}

export interface ManagedChunk {
  channel: BrowserAudioChannel;
  index: number;
  bytes: Uint8Array;
}

export interface ManagedUploadResult {
  uploadId: string;
  jobId: string;
  meetingId: string;
}

/**
 * The project-operated Hosted service is deliberately fixed. A person using
 * the extension should never need to discover, type, or trust an API origin.
 * Self-hosted history remains a separate explicit configuration in Settings.
 */
export const MANAGED_SERVICE_ORIGIN = "https://ai-notetaker.apercallc.com";

export interface ManagedCalendarEvent {
  title: string;
  attendees: string[];
  startsAt: string;
  endsAt: string;
  meetUrl?: string;
}

export interface ManagedDriveExportResult {
  fileId: string;
  webViewLink?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_MAX_ATTEMPTS = 3;
const REQUEST_RETRY_BASE_MS = 250;

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 5_000);
  }
  return Math.min(REQUEST_RETRY_BASE_MS * 2 ** attempt, 2_000);
}

function waitForRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serviceUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Managed service URL is invalid");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")) {
    throw new Error("Managed service URL must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

/** Open the hosted service's account-creation page without accepting an
 * arbitrary non-HTTPS destination from onboarding input. */
export function managedSignupUrl(baseUrl: string): string {
  return `${serviceUrl(baseUrl)}/login?mode=signup`;
}

/** Builds the billing page link only after applying the same HTTPS/origin
 * validation used for hosted sign-in. Persisted settings are untrusted input
 * too, so UI rendering must not interpolate a raw service URL into href. */
export function managedBillingUrl(baseUrl: string): string {
  return `${serviceUrl(baseUrl)}/billing`;
}

/** The browser account page owns server-side Google OAuth connections. */
export function managedIntegrationsUrl(baseUrl: string): string {
  return `${serviceUrl(baseUrl)}/account#google-services`;
}

/**
 * Hosted mode is opt-in and the service URL is user-provided, so do not ship
 * a permanent all-origins permission. Chrome asks for the exact origin when
 * the user presses the explicit Hosted AI sign-in button. The no-op fallback
 * keeps this library usable in Firefox/test harnesses that do not expose the
 * permissions API.
 */
async function requestServiceOriginPermission(baseUrl: string): Promise<void> {
  const permissions = chrome.permissions;
  if (!permissions?.request) return;
  const origin = new URL(serviceUrl(baseUrl)).origin;
  const granted = await permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error("Allow access to the hosted service origin to sign in to Hosted AI");
}

async function requestJson(
  config: ManagedServiceConfig,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${serviceUrl(config.baseUrl)}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.accessToken}`,
          "X-Workspace-Id": config.workspaceId,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt === REQUEST_MAX_ATTEMPTS - 1) throw error;
      await waitForRetry(retryDelayMs(attempt));
      continue;
    }
    clearTimeout(timer);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return body;
    if (!retryableStatus(response.status) || attempt === REQUEST_MAX_ATTEMPTS - 1) {
      throw new Error(typeof body.error === "string" ? body.error : `Managed service request failed (${response.status})`);
    }
    await waitForRetry(retryDelayMs(attempt, response));
  }
  throw new Error("Managed service request failed");
}

export async function loginManaged(
  baseUrl: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedLoginResult> {
  const normalizedBaseUrl = serviceUrl(baseUrl);
  await requestServiceOriginPermission(normalizedBaseUrl);
  const response = await fetchImpl(`${normalizedBaseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.accessToken !== "string" || typeof body.accountId !== "string" || typeof body.workspaceId !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : "Managed service sign-in failed");
  }
  return {
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
    config: {
      baseUrl: normalizedBaseUrl,
      accessToken: body.accessToken,
      accountId: body.accountId,
      workspaceId: body.workspaceId,
      plan: typeof body.plan === "string" ? body.plan : "local",
    },
  };
}

/** Fetches server-authoritative plan/quota state before a managed recording starts. */
export async function getManagedEntitlements(
  config: ManagedServiceConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedEntitlements> {
  const body = await requestJson(config, "/api/v1/entitlements", { method: "GET" }, fetchImpl);
  const numberField = (name: string): number => (typeof body[name] === "number" && Number.isFinite(body[name]) ? body[name] as number : 0);
  return {
    plan: typeof body.plan === "string" ? body.plan : "local",
    status: typeof body.status === "string" ? body.status : "inactive",
    used: numberField("used"),
    limit: numberField("limit"),
    remaining: numberField("remaining"),
    canProcess: body.canProcess === true,
    inPaymentGrace: body.inPaymentGrace === true,
  };
}

/** Calendar metadata is resolved by the service; Google tokens never reach Chrome. */
export async function getManagedGoogleCalendarEvent(
  config: ManagedServiceConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedCalendarEvent | null> {
  const body = await requestJson(config, "/api/v1/google/calendar/current", { method: "GET" }, fetchImpl);
  const event = body.event;
  if (!event || typeof event !== "object") return null;
  const value = event as Record<string, unknown>;
  if (typeof value.title !== "string" || typeof value.startsAt !== "string" || typeof value.endsAt !== "string") return null;
  return {
    title: value.title,
    attendees: Array.isArray(value.attendees) ? value.attendees.filter((item): item is string => typeof item === "string").slice(0, 200) : [],
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    ...(typeof value.meetUrl === "string" ? { meetUrl: value.meetUrl } : {}),
  };
}

/** Export is server-owned, so the Drive refresh token stays encrypted at rest. */
export async function exportManagedMeetingToGoogleDrive(
  config: ManagedServiceConfig,
  meetingId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedDriveExportResult> {
  const body = await requestJson(config, "/api/v1/google/drive/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meetingId }),
  }, fetchImpl);
  if (typeof body.fileId !== "string" || !body.fileId) throw new Error("Managed service returned no Google Drive file id");
  return { fileId: body.fileId, ...(typeof body.webViewLink === "string" ? { webViewLink: body.webViewLink } : {}) };
}

/**
 * Register the durable meeting before creating its managed upload. The API
 * deliberately keeps this separate from upload creation so retries can safely
 * re-register the same meeting without duplicating it.
 */
export async function registerManagedMeeting(
  config: ManagedServiceConfig,
  meeting: MeetingRecord,
  endedAt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await requestJson(config, "/api/v1/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: meeting.id,
      title: meeting.title,
      mode: meeting.mode ?? "general",
      startedAt: meeting.startedAt,
      endedAt,
      transcript: [],
      summary: "",
      actionItems: [],
      captureSource: "meet",
      processingMode: "managed",
    }),
  }, fetchImpl);
}

/**
 * What gets uploaded. The array form is kept for small inputs and existing
 * callers; the streaming form is the only safe shape for a real Meet
 * recording — the manifest totals come from a key-only stats pass, and the
 * chunks are pulled one at a time from IndexedDB so the service worker's
 * heap never holds more than a single chunk (~48 kB) of audio.
 */
export type ManagedChunkSource = ManagedChunk[] | {
  totalChunks: number;
  totalBytes: number;
  chunks: AsyncIterable<ManagedChunk>;
};

function isStreamingSource(source: ManagedChunkSource): source is { totalChunks: number; totalBytes: number; chunks: AsyncIterable<ManagedChunk> } {
  return !Array.isArray(source);
}

/** PUTs one chunk with its SHA-256; shared by the array and streaming paths. */
async function putManagedChunk(
  config: ManagedServiceConfig,
  uploadId: string,
  index: number,
  chunk: ManagedChunk,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bytes = chunk.bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await requestJson(config, `/api/v1/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "x-chunk-sha256": checksum, "x-audio-channel": chunk.channel },
    body: bytes.buffer as ArrayBuffer,
  }, fetchImpl);
}

export async function uploadManagedMeeting(
  config: ManagedServiceConfig,
  meetingId: string,
  source: ManagedChunkSource,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedUploadResult> {
  const { totalChunks, totalBytes } = isStreamingSource(source)
    ? source
    : { totalChunks: source.length, totalBytes: source.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0) };
  if (totalChunks === 0) throw new Error("A managed meeting must contain at least one audio chunk");
  const idempotencyKey = `meeting:${meetingId}`;
  const manifest = await requestJson(config, "/api/v1/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ meetingId, totalChunks, totalBytes, idempotencyKey }),
  }, fetchImpl);
  const uploadId = typeof manifest.uploadId === "string" ? manifest.uploadId : "";
  if (!uploadId) throw new Error("Managed service returned no upload id");

  // A retry after a completed upload must go straight to processing. The
  // server keeps the upload idempotent and correctly rejects PUTs against a
  // completed manifest, so replaying every chunk here would turn a recoverable
  // provider failure into a client-visible upload failure.
  if (manifest.status !== "complete") {
    if (isStreamingSource(source)) {
      // Streamed chunks carry their storage sequence, not their manifest
      // index; the manifest expects dense 0..N-1 indices in iteration order.
      let index = 0;
      for await (const chunk of source.chunks) {
        await putManagedChunk(config, uploadId, index, chunk, fetchImpl);
        index += 1;
      }
    } else {
      for (const chunk of source) {
        await putManagedChunk(config, uploadId, chunk.index, chunk, fetchImpl);
      }
    }

    await requestJson(config, `/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST" }, fetchImpl);
  }
  const job = await requestJson(config, `/api/v1/meetings/${encodeURIComponent(meetingId)}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId, idempotencyKey }),
  }, fetchImpl);
  if (typeof job.jobId !== "string") throw new Error("Managed service returned no processing job id");
  return { uploadId, jobId: job.jobId, meetingId };
}

/** Auto-share result: an expiring attendee link created after notes complete. */
export interface ManagedShareResult {
  shareId: string;
  shareUrl: string;
  expiresAt: string;
}

/** Creates an expiring share link server-side; the token never touches Meet tabs. */
export async function createManagedMeetingShare(
  config: ManagedServiceConfig,
  meetingId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedShareResult> {
  const body = await requestJson(config, `/api/v1/meetings/${encodeURIComponent(meetingId)}/share`, { method: "POST" }, fetchImpl);
  if (typeof body.shareUrl !== "string" || !body.shareUrl) throw new Error("Managed service returned no share URL");
  return {
    shareId: typeof body.shareId === "string" ? body.shareId : "",
    shareUrl: body.shareUrl,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
  };
}

export async function getManagedJob(config: ManagedServiceConfig, jobId: string, fetchImpl: typeof fetch = fetch): Promise<{ status: string; meetingId: string; message?: string; summary?: string; actionItems?: ActionItem[] }> {
  const body = await requestJson(config, `/api/v1/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, fetchImpl);
  const result = body.meeting as { summary?: unknown; actionItems?: unknown } | undefined;
  return {
    status: typeof body.status === "string" ? body.status : "error",
    meetingId: typeof body.meetingId === "string" ? body.meetingId : "",
    message: typeof body.message === "string" ? body.message : undefined,
    summary: typeof result?.summary === "string" ? result.summary : undefined,
    actionItems: Array.isArray(result?.actionItems) ? result.actionItems.filter((item): item is ActionItem => typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string") : undefined,
  };
}
