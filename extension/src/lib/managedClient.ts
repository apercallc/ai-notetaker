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

export interface ManagedDriveExportResult {
  fileId: string;
  webViewLink?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 20_000;
const REQUEST_MAX_ATTEMPTS = 3;
const AUDIO_UPLOAD_ERROR = "We couldn't upload your recording. Your audio is saved on this device. Try again.";
const REQUEST_RETRY_BASE_MS = 250;

// A 4 MiB audio chunk cannot finish in 15 s on a modest uplink. Scale the
// deadline with the payload, assuming at least ~0.5 Mbps (64 KiB/s).
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

function requestTimeoutMs(body: RequestInit["body"]): number {
  let bytes = 0;
  if (body instanceof Blob) bytes = body.size;
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) bytes = body.byteLength;
  else if (typeof body === "string") bytes = body.length;
  return REQUEST_TIMEOUT_MS + Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1_000);
}

/** The hosted session is no longer accepted (expired or revoked). Only signing in again fixes it. */
export class ManagedAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedAuthError";
  }
}

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

export function serviceUrl(baseUrl: string): string {
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
  return `${serviceUrl(baseUrl)}/login?tab=signup`;
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
 * Hosted mode is opt-in, so do not ship
 * a permanent all-origins permission. Chrome asks for the exact origin when
 * the user presses the explicit Hosted AI sign-in button. The no-op fallback
 * keeps this library usable in Firefox/test harnesses that do not expose the
 * permissions API.
 */
export async function requestServiceOriginPermission(baseUrl: string, additional: chrome.permissions.Permissions = {}): Promise<void> {
  const permissions = chrome.permissions;
  if (!permissions?.request) return;
  const origin = new URL(serviceUrl(baseUrl)).origin;
  const granted = await permissions.request({
    ...additional,
    origins: [...new Set([...(additional.origins ?? []), `${origin}/*`])],
  });
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
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs(init.body));
    let response: Response | undefined;
    let body: Record<string, unknown> = {};
    let requestError: unknown;
    let requestFailed = false;
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
      try {
        const parsed: unknown = await response.json();
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch (error) {
        // Preserve the existing empty-body behavior for malformed JSON, but
        // treat body-stream failures and aborts as transport failures so the
        // whole request can be retried. In particular, do not return success
        // after the timeout aborts a response whose headers already arrived.
        if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error;
        body = {};
      }
    } catch (error) {
      requestFailed = true;
      requestError = error;
    } finally {
      // Keep the request deadline active until the body is fully consumed.
      // This also covers fetch errors, body parse errors, and normal returns.
      clearTimeout(timer);
    }
    if (requestFailed) {
      if (attempt === REQUEST_MAX_ATTEMPTS - 1) throw requestError;
      await waitForRetry(retryDelayMs(attempt));
      continue;
    }
    if (!response) throw new Error("Managed service request failed");
    if (response.ok) return body;
    if (response.status === 401) {
      throw new ManagedAuthError(typeof body.error === "string" ? body.error : "Your hosted session has expired. Sign in again, then retry.");
    }
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
  let response: Response;
  try {
    response = await fetchImpl(`${normalizedBaseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch {
    // Offline, a stalled server, or a blocked host: say so, instead of "Failed to fetch".
    throw new Error("Could not reach the hosted service. Check your connection and try again.");
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : "a minute"}.` : " Try again later.";
    throw new Error(`Too many sign-in attempts.${wait}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return managedLoginResult(normalizedBaseUrl, body, response.ok);
}

/** Normalize both password and Google sign-in responses into the saved local session contract. */
export function managedLoginResult(baseUrl: string, body: Record<string, unknown>, ok = true): ManagedLoginResult {
  if (!ok || typeof body.accessToken !== "string" || typeof body.accountId !== "string" || typeof body.workspaceId !== "string") {
    throw new Error(typeof body.error === "string" ? body.error : "Hosted AI sign-in failed.");
  }
  return {
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
    config: {
      baseUrl: serviceUrl(baseUrl),
      accessToken: body.accessToken,
      accountId: body.accountId,
      workspaceId: body.workspaceId,
      plan: typeof body.plan === "string" ? body.plan : "local",
    },
  };
}

function randomBase64Url(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function launchGoogleFlow(url: string): Promise<string> {
  const identity = chrome.identity;
  if (!identity?.launchWebAuthFlow || !identity.getRedirectURL) {
    return Promise.reject(new Error("Google sign-in is not available in this browser."));
  }
  return new Promise((resolve, reject) => {
    identity.launchWebAuthFlow({ url, interactive: true }, (callbackUrl) => {
      const error = chrome.runtime.lastError;
      if (error || !callbackUrl) {
        reject(new Error("Google sign-in was closed before it finished. Try again, or sign in with email."));
        return;
      }
      resolve(callbackUrl);
    });
  });
}

/** Sign into the hosted account in Google's browser flow without handing an API token through a URL. */
export async function loginManagedWithGoogle(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedLoginResult> {
  const normalizedBaseUrl = serviceUrl(baseUrl);
  // `identity` is optional. Chrome may not expose chrome.identity until
  // the user grants it, so request it before checking the API surface.
  await requestServiceOriginPermission(normalizedBaseUrl, { permissions: ["identity"] });
  const identity = chrome.identity;
  if (!identity?.getRedirectURL || !identity.launchWebAuthFlow) {
    throw new Error("Google sign-in is not available in this browser.");
  }

  const redirectUri = identity.getRedirectURL("hosted-auth");
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(32);
  const params = new URLSearchParams({
    mode: "signin",
    client: "extension",
    redirect_uri: redirectUri,
    code_challenge: await pkceChallenge(verifier),
    client_state: state,
  });
  const startUrl = `${normalizedBaseUrl}/api/google/oauth/start?${params.toString()}`;
  const callbackUrl = await launchGoogleFlow(startUrl);
  const expected = new URL(redirectUri);
  const returned = new URL(callbackUrl);
  if (returned.origin !== expected.origin || returned.pathname !== expected.pathname) {
    throw new Error("Google sign-in returned to an unexpected address. Try again.");
  }
  const result = new URLSearchParams(returned.hash.replace(/^#/u, ""));
  if (result.get("state") !== state) throw new Error("Google sign-in could not be verified. Try again.");
  if (result.has("error")) {
    const error = result.get("error");
    throw new Error(error === "google-no-account"
      ? "No Hosted AI account is linked to this Google address yet. Create an account on the web, then try again."
      : error === "google-cancelled"
        ? "Google sign-in was cancelled."
        : "Google sign-in could not be completed. Try again.");
  }
  const code = result.get("code");
  if (!code) throw new Error("Google sign-in did not return a usable authorization code. Try again.");

  let response: Response;
  try {
    response = await fetchImpl(`${normalizedBaseUrl}/api/v1/auth/google/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Could not finish Google sign-in. Check your connection and try again.");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return managedLoginResult(normalizedBaseUrl, body, response.ok);
}

/** Fetches server-authoritative plan/quota state before a managed recording starts. */
export async function getManagedEntitlements(
  config: ManagedServiceConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedEntitlements> {
  const body = await requestJson(config, "/api/v1/entitlements", { method: "GET" }, fetchImpl);
  const numberField = (name: string): number => (typeof body[name] === "number" && Number.isFinite(body[name]) ? body[name] as number : 0);
  return {
    planLabel: typeof body.planLabel === "string" ? body.planLabel : "Hosted AI plan",
    plan: typeof body.plan === "string" ? body.plan : "local",
    status: typeof body.status === "string" ? body.status : "inactive",
    used: numberField("used"),
    limit: numberField("limit"),
    remaining: numberField("remaining"),
    warning: body.warning === "low" || body.warning === "exhausted" ? body.warning : "none",
    audio: {
      remainingSeconds: typeof (body.audio as Record<string, unknown> | undefined)?.remainingSeconds === "number"
        ? (body.audio as { remainingSeconds: number }).remainingSeconds
        : 0,
      warning: ["low", "exhausted"].includes(String((body.audio as Record<string, unknown> | undefined)?.warning))
        ? (body.audio as { warning: "low" | "exhausted" }).warning
        : "none",
    },
    canProcess: body.canProcess === true,
    inPaymentGrace: body.inPaymentGrace === true,
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
 * chunks are packed from IndexedDB into bounded channel buffers so a long
 * recording never has to fit in the service worker's heap.
 */
export type ManagedChunkSource = ManagedChunk[] | {
  totalChunks: number;
  totalBytes: number;
  /** Versioned packing avoids conflicts with an older incomplete manifest. */
  uploadLayout?: string;
  chunks: AsyncIterable<ManagedChunk>;
};

function isStreamingSource(source: ManagedChunkSource): source is Exclude<ManagedChunkSource, ManagedChunk[]> {
  return !Array.isArray(source);
}

/** PUTs one chunk with its SHA-256; shared by the array and streaming paths. */
async function putManagedChunk(
  config: ManagedServiceConfig,
  uploadId: string,
  index: number,
  chunk: ManagedChunk,
  fetchImpl: typeof fetch,
  directUpload = false,
): Promise<void> {
  const bytes = chunk.bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (directUpload) {
    const path = `/api/v1/uploads/${encodeURIComponent(uploadId)}/chunks/${index}/direct`;
    const prepared = await requestJson(config, path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ byteLength: bytes.byteLength, checksum, channel: chunk.channel }),
    }, fetchImpl);
    if (prepared.replayed === true) return;
    if (typeof prepared.url !== "string") throw new Error(AUDIO_UPLOAD_ERROR);
    const url = new URL(prepared.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(AUDIO_UPLOAD_ERROR);
    // Storage never receives account cookies, workspace tokens or provider keys.
    // A 412 after an ambiguous PUT means the immutable object already exists;
    // server completion still independently checks its size and SHA-256.
    for (let attempt = 0; attempt < REQUEST_MAX_ATTEMPTS; attempt += 1) {
      let permanent = false;
      try {
        const response = await fetchImpl(url.toString(), {
          method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
          body: bytes.buffer as ArrayBuffer, credentials: "omit", redirect: "error",
          signal: AbortSignal.timeout(requestTimeoutMs(bytes.buffer as ArrayBuffer)),
        });
        if (response.ok || response.status === 412) break;
        permanent = !retryableStatus(response.status);
        if (permanent || attempt === REQUEST_MAX_ATTEMPTS - 1) throw new Error(AUDIO_UPLOAD_ERROR);
      } catch { if (permanent || attempt === REQUEST_MAX_ATTEMPTS - 1) throw new Error(AUDIO_UPLOAD_ERROR); }
      await waitForRetry(retryDelayMs(attempt));
    }
    await requestJson(config, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "complete" }) }, fetchImpl);
    return;
  }
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
  const uploadKey = isStreamingSource(source) && source.uploadLayout ? `${idempotencyKey}:${source.uploadLayout}` : idempotencyKey;
  const manifest = await requestJson(config, "/api/v1/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": uploadKey },
    body: JSON.stringify({ meetingId, totalChunks, totalBytes, idempotencyKey: uploadKey }),
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
        await putManagedChunk(config, uploadId, index, chunk, fetchImpl, manifest.directUpload === true);
        index += 1;
      }
    } else {
      for (const chunk of source) {
        await putManagedChunk(config, uploadId, chunk.index, chunk, fetchImpl, manifest.directUpload === true);
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
