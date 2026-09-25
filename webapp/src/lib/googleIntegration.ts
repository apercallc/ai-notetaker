import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { getAppUrl } from "./deploymentConfig";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DOCS_ENDPOINT = "https://docs.googleapis.com/v1/documents";
const REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const ENCRYPTION_VERSION = "v1";

export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
].join(" ");

export class GoogleIntegrationError extends Error {
  constructor(
    public readonly publicMessage: string,
    public readonly status: number = 502,
  ) {
    super(publicMessage);
  }
}

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  encryptionKey: Buffer;
  appUrl: string;
}

interface OAuthState {
  userId: string;
  state: string;
  verifier: string;
  expiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

type UsableGoogleTokenResponse = GoogleTokenResponse & { access_token: string; expires_in: number };

export interface GoogleCalendarEvent {
  title: string;
  attendees: string[];
  startsAt: string;
  endsAt: string;
  meetUrl?: string;
}

function configuredValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function encryptionKey(): Buffer | null {
  const raw = configuredValue("GOOGLE_OAUTH_ENCRYPTION_KEY");
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/** Deliberately returns only a non-secret readiness boolean for UI/API use. */
export function googleOAuthConfigured(): boolean {
  try {
    return Boolean(configuredValue("GOOGLE_OAUTH_CLIENT_ID") && configuredValue("GOOGLE_OAUTH_CLIENT_SECRET") && encryptionKey() && configuredValue("APP_URL") && getAppUrl());
  } catch {
    return false;
  }
}

function getGoogleConfig(): GoogleConfig {
  const clientId = configuredValue("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = configuredValue("GOOGLE_OAUTH_CLIENT_SECRET");
  const key = encryptionKey();
  if (!clientId || !clientSecret || !key || !configuredValue("APP_URL")) {
    throw new GoogleIntegrationError("Google integration is not configured. Ask an administrator to configure it.", 503);
  }
  try {
    return { clientId, clientSecret, encryptionKey: key, appUrl: getAppUrl() };
  } catch {
    throw new GoogleIntegrationError("Google integration is not configured. Ask an administrator to configure it.", 503);
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [ENCRYPTION_VERSION, base64Url(iv), base64Url(cipher.getAuthTag()), base64Url(ciphertext)].join(".");
}

function decrypt(value: string, key: Buffer): string {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== ENCRYPTION_VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new GoogleIntegrationError("Google connection needs to be reconnected.", 409);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new GoogleIntegrationError("Google connection needs to be reconnected.", 409);
  }
}

function oauthRedirectUri(config: GoogleConfig): string {
  return new URL("/api/google/oauth/callback", config.appUrl).toString();
}

export function createOAuthState(userId: string): { state: OAuthState; authorizationUrl: string } {
  const config = getGoogleConfig();
  const verifier = base64Url(randomBytes(32));
  const state: OAuthState = {
    userId,
    state: base64Url(randomBytes(32)),
    verifier,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  };
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: oauthRedirectUri(config),
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: state.state,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
  });
  return { state, authorizationUrl: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}` };
}

/** The state cookie is encrypted and HttpOnly; it contains the PKCE verifier, never Google credentials. */
export function sealOAuthState(state: OAuthState): string {
  return encrypt(JSON.stringify(state), getGoogleConfig().encryptionKey);
}

export function openOAuthState(value: string): OAuthState | null {
  try {
    const parsed = JSON.parse(decrypt(value, getGoogleConfig().encryptionKey)) as Partial<OAuthState>;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.verifier !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt < Date.now()
    ) return null;
    return parsed as OAuthState;
  } catch {
    return null;
  }
}

export function oauthStateMatches(expected: string, received: string | null): boolean {
  if (!received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

async function googleTokenRequest(body: URLSearchParams): Promise<UsableGoogleTokenResponse> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleIntegrationError("Google could not be reached. Try again.");
  }
  if (!response.ok) throw new GoogleIntegrationError("Google authorization was not accepted. Try connecting again.", 400);
  const tokens = (await response.json()) as GoogleTokenResponse;
  const accessToken = tokens.access_token;
  const expiresIn = tokens.expires_in;
  if (!accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new GoogleIntegrationError("Google did not return usable authorization. Try connecting again.", 400);
  }
  return { ...tokens, access_token: accessToken, expires_in: expiresIn };
}

async function lookupGoogleAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { email?: unknown };
    return typeof body.email === "string" && body.email.length <= 320 ? body.email : null;
  } catch {
    return null;
  }
}

export async function completeOAuthConnection(userId: string, code: string, state: OAuthState): Promise<void> {
  const config = getGoogleConfig();
  const tokens = await googleTokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    code_verifier: state.verifier,
    grant_type: "authorization_code",
    redirect_uri: oauthRedirectUri(config),
  }));
  if (!tokens.refresh_token) {
    throw new GoogleIntegrationError("Google did not grant offline access. Remove the connection and try again.", 400);
  }
  const accountEmail = await lookupGoogleAccountEmail(tokens.access_token);
  await prisma.googleOAuthConnection.upsert({
    where: { userId },
    create: {
      userId,
      accountEmail,
      accessTokenCiphertext: encrypt(tokens.access_token, config.encryptionKey),
      refreshTokenCiphertext: encrypt(tokens.refresh_token, config.encryptionKey),
      expiresAt: new Date(Date.now() + Number(tokens.expires_in) * 1_000),
      scopes: tokens.scope || GOOGLE_OAUTH_SCOPES,
    },
    update: {
      accountEmail,
      accessTokenCiphertext: encrypt(tokens.access_token, config.encryptionKey),
      refreshTokenCiphertext: encrypt(tokens.refresh_token, config.encryptionKey),
      expiresAt: new Date(Date.now() + Number(tokens.expires_in) * 1_000),
      scopes: tokens.scope || GOOGLE_OAUTH_SCOPES,
    },
  });
}

async function accessTokenFor(userId: string): Promise<string> {
  const config = getGoogleConfig();
  const connection = await prisma.googleOAuthConnection.findUnique({ where: { userId } });
  if (!connection) throw new GoogleIntegrationError("Google connection required.", 409);
  const accessToken = decrypt(connection.accessTokenCiphertext, config.encryptionKey);
  if (connection.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) return accessToken;
  const refreshToken = decrypt(connection.refreshTokenCiphertext, config.encryptionKey);
  const tokens = await googleTokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }));
  await prisma.googleOAuthConnection.update({
    where: { userId },
    data: {
      accessTokenCiphertext: encrypt(tokens.access_token, config.encryptionKey),
      ...(tokens.refresh_token ? { refreshTokenCiphertext: encrypt(tokens.refresh_token, config.encryptionKey) } : {}),
      expiresAt: new Date(Date.now() + Number(tokens.expires_in) * 1_000),
      ...(tokens.scope ? { scopes: tokens.scope } : {}),
    },
  });
  return tokens.access_token;
}

async function googleRequest(userId: string, url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await accessTokenFor(userId);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleIntegrationError("Google could not be reached. Try again.");
  }
  if (response.status === 401 && retry) {
    await prisma.googleOAuthConnection.updateMany({ where: { userId }, data: { expiresAt: new Date(0) } });
    return googleRequest(userId, url, init, false);
  }
  if (!response.ok) throw new GoogleIntegrationError("Google request failed. Try again.");
  return response;
}

function parseCalendarEvent(value: unknown): GoogleCalendarEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { summary?: unknown; attendees?: Array<{ displayName?: unknown; email?: unknown }>; start?: { dateTime?: unknown }; end?: { dateTime?: unknown }; hangoutLink?: unknown; conferenceData?: { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> } };
  if (typeof event.start?.dateTime !== "string" || typeof event.end?.dateTime !== "string") return null;
  const videoEntry = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video" && typeof entry.uri === "string")?.uri;
  return {
    title: typeof event.summary === "string" ? event.summary : "",
    attendees: (event.attendees ?? []).map((attendee) => typeof attendee.displayName === "string" ? attendee.displayName : typeof attendee.email === "string" ? attendee.email : "").filter(Boolean),
    startsAt: event.start.dateTime,
    endsAt: event.end.dateTime,
    ...(typeof event.hangoutLink === "string" ? { meetUrl: event.hangoutLink } : typeof videoEntry === "string" ? { meetUrl: videoEntry } : {}),
  };
}

export async function findCurrentGoogleCalendarEvent(userId: string, now = new Date()): Promise<GoogleCalendarEvent | null> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: start.toISOString(), timeMax: end.toISOString() });
  const response = await googleRequest(userId, `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}?${params.toString()}`);
  const body = (await response.json()) as { items?: unknown[] };
  const nowMs = now.getTime();
  const events = (body.items ?? []).map(parseCalendarEvent).filter((event): event is GoogleCalendarEvent => event !== null);
  return events.find((event) => new Date(event.startsAt).getTime() <= nowMs && nowMs <= new Date(event.endsAt).getTime()) ?? null;
}

function formatMeetingForGoogleDoc(meeting: { title: string; startedAt: Date; endedAt: Date; summary: string; transcript: Array<{ speaker: string; text: string; timestamp: Date }>; actionItems: Array<{ text: string; owner: string | null; status: string; dueAt: Date | null }> }): string {
  const lines = [
    meeting.title,
    "",
    `Started: ${meeting.startedAt.toISOString()}`,
    `Ended: ${meeting.endedAt.toISOString()}`,
    "",
    "Summary",
    meeting.summary || "No summary recorded.",
    "",
    "Action items",
    ...(meeting.actionItems.length ? meeting.actionItems.map((item) => `- [${item.status}] ${item.text}${item.owner ? ` (${item.owner})` : ""}${item.dueAt ? ` — due ${item.dueAt.toISOString().slice(0, 10)}` : ""}`) : ["None"]),
    "",
    "Transcript",
    ...(meeting.transcript.length ? meeting.transcript.map((segment) => `[${segment.timestamp.toISOString()}] ${segment.speaker}: ${segment.text}`) : ["No transcript recorded."]),
  ];
  return lines.join("\n");
}

async function findOrCreateExportFolder(userId: string): Promise<string> {
  const query = "trashed = false and name = 'ai-notetaker' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents";
  const existing = await googleRequest(userId, `${GOOGLE_DRIVE_FILES_ENDPOINT}?${new URLSearchParams({ q: query, pageSize: "1", fields: "files(id)" }).toString()}`);
  const existingBody = (await existing.json()) as { files?: Array<{ id?: string }> };
  if (existingBody.files?.[0]?.id) return existingBody.files[0].id;
  const created = await googleRequest(userId, `${GOOGLE_DRIVE_FILES_ENDPOINT}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ai-notetaker", mimeType: "application/vnd.google-apps.folder", parents: ["root"] }),
  });
  const body = (await created.json()) as { id?: string };
  if (!body.id) throw new GoogleIntegrationError("Google Drive did not create an export folder.");
  return body.id;
}

export async function exportMeetingToGoogleDrive(userId: string, workspaceId: string, meetingId: string): Promise<{ fileId: string; webViewLink?: string }> {
  // Fail configuration before revealing whether a meeting id exists to a
  // deployment that cannot perform the requested server-owned export.
  getGoogleConfig();
  if (!meetingId || meetingId.length > 128) throw new GoogleIntegrationError("meetingId is required.", 400);
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId, endedAt: { lte: new Date() } },
    include: { transcript: { orderBy: { order: "asc" } }, actionItems: { orderBy: { id: "asc" } } },
  });
  if (!meeting) throw new GoogleIntegrationError("Completed meeting not found.", 404);
  const folderId = await findOrCreateExportFolder(userId);
  const created = await googleRequest(userId, `${GOOGLE_DRIVE_FILES_ENDPOINT}?fields=id,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `${meeting.title} — ${meeting.startedAt.toISOString().slice(0, 10)}`, mimeType: "application/vnd.google-apps.document", parents: [folderId] }),
  });
  const file = (await created.json()) as { id?: string; webViewLink?: string };
  if (!file.id) throw new GoogleIntegrationError("Google Drive did not create an export document.");
  await googleRequest(userId, `${GOOGLE_DOCS_ENDPOINT}/${encodeURIComponent(file.id)}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: formatMeetingForGoogleDoc(meeting) } }] }),
  });
  return { fileId: file.id, ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}) };
}

export async function googleConnectionStatus(userId: string): Promise<{ configured: boolean; connected: boolean; accountEmail: string | null }> {
  const configured = googleOAuthConfigured();
  if (!configured) return { configured: false, connected: false, accountEmail: null };
  const connection = await prisma.googleOAuthConnection.findUnique({ where: { userId }, select: { accountEmail: true } });
  return { configured: true, connected: Boolean(connection), accountEmail: connection?.accountEmail ?? null };
}

export async function disconnectGoogle(userId: string): Promise<void> {
  await prisma.googleOAuthConnection.deleteMany({ where: { userId } });
}
