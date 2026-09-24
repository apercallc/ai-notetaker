import { generatePkcePair } from "./calendar";
import { driveTitle, formatMeetingNotes } from "./meetingNotes";
import type { DriveConnection, MeetingRecord } from "../types";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DOCS_ENDPOINT = "https://docs.googleapis.com/v1/documents";
const REQUEST_TIMEOUT_MS = 10_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface DriveFile {
  id: string;
  webViewLink?: string;
}

function launchWebAuthFlow(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Google Drive authorization was cancelled"));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

export function buildDriveAuthorizationUrl(clientId: string, redirectUri: string, challenge: string, state = "state"): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function connectGoogleDrive(
  clientId: string,
  clientSecret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DriveConnection> {
  const redirectUri = chrome.identity.getRedirectURL();
  const { verifier, challenge } = await generatePkcePair();
  const state = crypto.randomUUID();
  const redirectUrl = await launchWebAuthFlow(buildDriveAuthorizationUrl(clientId, redirectUri, challenge, state));
  const params = new URL(redirectUrl).searchParams;
  const code = params.get("code");
  if (!code) throw new Error(params.get("error") ?? "Google Drive authorization did not return a code");
  if (params.get("state") !== state) throw new Error("Google Drive authorization state did not match");

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Drive token exchange failed: ${response.status}`);
  const tokens = (await response.json()) as TokenResponse;
  if (!tokens.access_token) throw new Error("Google Drive did not return an access token");
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

async function refreshAccessToken(connection: DriveConnection, fetchImpl: typeof fetch): Promise<string | null> {
  if (!connection.refreshToken) return null;
  const body = new URLSearchParams({
    client_id: connection.clientId,
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  });
  if (connection.clientSecret) body.set("client_secret", connection.clientSecret);
  try {
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const tokens = (await response.json()) as TokenResponse;
    if (!tokens.access_token) return null;
    connection.accessToken = tokens.access_token;
    connection.expiresAt = Date.now() + tokens.expires_in * 1000;
    return tokens.access_token;
  } catch {
    return null;
  }
}

async function request(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Drive request failed: ${response.status}`);
  return response;
}

async function withAccessToken<T>(
  connection: DriveConnection,
  fetchImpl: typeof fetch,
  operation: (token: string) => Promise<T>,
): Promise<T> {
  let token = connection.accessToken;
  if (connection.expiresAt <= Date.now() + 30_000) {
    token = (await refreshAccessToken(connection, fetchImpl)) ?? token;
  }
  try {
    return await operation(token);
  } catch (error) {
    if (error instanceof Error && error.message === "Drive request failed: 401") {
      const refreshed = await refreshAccessToken(connection, fetchImpl);
      if (refreshed) return operation(refreshed);
    }
    throw error;
  }
}

async function findOrCreateFolder(connection: DriveConnection, fetchImpl: typeof fetch): Promise<string> {
  return withAccessToken(connection, fetchImpl, async (token) => {
    const query = encodeURIComponent("trashed = false and name = 'ai-notetaker' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents");
    const existingResponse = await request(`${DRIVE_FILES_ENDPOINT}?q=${query}&pageSize=100&orderBy=name&fields=files(id,name)`, token, fetchImpl);
    const existing = (await existingResponse.json()) as { files?: Array<{ id: string }> };
    const folder = (existing.files ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    if (folder?.id) return folder.id;

    const created = await request(`${DRIVE_FILES_ENDPOINT}?fields=id,webViewLink`, token, fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ai-notetaker", mimeType: "application/vnd.google-apps.folder", parents: ["root"] }),
    });
    const file = (await created.json()) as { id?: string };
    if (!file.id) throw new Error("Google Drive did not return the ai-notetaker folder id");
    return file.id;
  });
}

export async function exportMeetingToDrive(
  meeting: MeetingRecord,
  connection: DriveConnection,
  fetchImpl: typeof fetch = fetch,
): Promise<{ fileId: string; webViewLink?: string }> {
  const folderId = await findOrCreateFolder(connection, fetchImpl);
  return withAccessToken(connection, fetchImpl, async (token) => {
    const created = await request(`${DRIVE_FILES_ENDPOINT}?fields=id,webViewLink`, token, fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: driveTitle(meeting),
        mimeType: "application/vnd.google-apps.document",
        parents: [folderId],
      }),
    });
    const file = (await created.json()) as DriveFile;
    if (!file.id) throw new Error("Google Drive did not return the meeting document id");
    await request(`${DOCS_ENDPOINT}/${encodeURIComponent(file.id)}:batchUpdate`, token, fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: formatMeetingNotes(meeting) } }] }),
    });
    return { fileId: file.id, ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}) };
  });
}
