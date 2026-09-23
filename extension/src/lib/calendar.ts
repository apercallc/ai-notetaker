/**
 * Google Calendar / Microsoft Graph read-only calendar lookup, used only
 * to auto-label a meeting's title and attendees at recording start (see
 * docs/superpowers/specs/2026-09-22-calendar-integration-design.md).
 *
 * BYOK OAuth: the user registers their own Google Cloud / Azure AD OAuth
 * app and pastes its Client ID (and, for Google, Client Secret) into
 * settings — never a project-owned shared OAuth client. This sidesteps
 * Google's consent-screen verification requirement entirely, since a
 * personal app's only ever test user is its owner.
 *
 * Every public function here is best-effort from the caller's point of
 * view: findCurrentEvent never throws, so a calendar problem can never
 * block or delay starting a recording.
 */

export interface CalendarEvent {
  title: string;
  attendees: string[];
  startsAt: string;
  endsAt: string;
}

export interface CalendarConnection {
  provider: "google" | "outlook";
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * Every network call in this module gets this bound — findCurrentEvent's
 * "never block or delay starting a recording" promise (module doc above)
 * requires it: without a timeout, a slow/hung Google or Microsoft
 * endpoint would otherwise delay startRecording by however long the
 * browser's own (long, unbounded-in-practice) network timeout takes.
 */
const CALENDAR_REQUEST_TIMEOUT_MS = 5_000;

interface ProviderConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  eventsUrl: (dayStartIso: string, dayEndIso: string) => string;
  parseEvents: (body: unknown) => CalendarEvent[];
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(digest);
  return { verifier, challenge };
}

function getRedirectUri(): string {
  return chrome.identity.getRedirectURL();
}

interface GoogleEventAttendee {
  displayName?: string;
  email?: string;
}

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
}

interface GoogleEvent {
  summary?: string;
  attendees?: GoogleEventAttendee[];
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
}

interface OutlookAttendeeEmailAddress {
  name?: string;
  address?: string;
}

interface OutlookEventAttendee {
  emailAddress?: OutlookAttendeeEmailAddress;
}

interface OutlookEventDateTime {
  dateTime?: string;
  timeZone?: string;
}

interface OutlookEvent {
  subject?: string;
  attendees?: OutlookEventAttendee[];
  start?: OutlookEventDateTime;
  end?: OutlookEventDateTime;
  isAllDay?: boolean;
}

/**
 * Microsoft Graph returns `2026-09-23T14:00:00.0000000` with the zone in a
 * sibling `timeZone` field rather than in the string, and `calendarView`
 * answers in UTC unless a `Prefer: outlook.timezone` header asks otherwise.
 * `new Date()` reads a date-time with no offset as *local* time, so left
 * alone every Outlook event lands wrong by the user's UTC offset — enough to
 * match the previous meeting, or none at all.
 */
function outlookIsoString(value: OutlookEventDateTime | undefined): string {
  const raw = value?.dateTime;
  if (!raw) return "";
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (hasOffset) return raw;
  // Anything other than UTC would need a real timezone database to resolve;
  // we only ever request the default, which is UTC.
  return value?.timeZone && value.timeZone.toUpperCase() !== "UTC" ? raw : `${raw}Z`;
}

const PROVIDER_CONFIG: Record<"google" | "outlook", ProviderConfig> = {
  google: {
    authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    eventsUrl: (dayStartIso, dayEndIso) =>
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(dayStartIso)}&timeMax=${encodeURIComponent(dayEndIso)}`,
    parseEvents: (body) => {
      const items = (body as { items?: GoogleEvent[] }).items ?? [];
      return (
        items
          // All-day entries carry `start.date` (a bare YYYY-MM-DD) instead of
          // `start.dateTime`, and they span the entire day — so "PTO",
          // "Conference", or a birthday would match as the current event and
          // silently become the title of a real meeting. Only timed events
          // describe something you could actually be in right now.
          .filter((item) => !!item.start?.dateTime && !!item.end?.dateTime)
          .map((item) => ({
            title: item.summary ?? "",
            attendees: (item.attendees ?? [])
              .map((attendee) => attendee.displayName || attendee.email || "")
              .filter((name) => name.length > 0),
            startsAt: item.start?.dateTime ?? "",
            endsAt: item.end?.dateTime ?? "",
          }))
      );
    },
  },
  outlook: {
    authEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Calendars.Read offline_access",
    eventsUrl: (dayStartIso, dayEndIso) =>
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(dayStartIso)}&endDateTime=${encodeURIComponent(dayEndIso)}`,
    parseEvents: (body) => {
      const items = (body as { value?: OutlookEvent[] }).value ?? [];
      return items
        // Same reason as Google's date-only filter: an all-day entry spans
        // the whole day and would hijack a real meeting's title.
        .filter((item) => item.isAllDay !== true)
        .map((item) => ({
          title: item.subject ?? "",
          attendees: (item.attendees ?? [])
            .map((attendee) => attendee.emailAddress?.name || attendee.emailAddress?.address || "")
            .filter((name) => name.length > 0),
          startsAt: outlookIsoString(item.start),
          endsAt: outlookIsoString(item.end),
        }));
    },
  },
};

export function buildAuthorizationUrl(
  provider: "google" | "outlook",
  clientId: string,
  redirectUri: string,
  challenge: string,
): string {
  const config = PROVIDER_CONFIG[provider];
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return `${config.authEndpoint}?${params.toString()}`;
}

function launchWebAuthFlow(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message ?? "calendar authorization was cancelled"));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function connectCalendar(
  provider: "google" | "outlook",
  clientId: string,
  clientSecret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarConnection> {
  const redirectUri = getRedirectUri();
  const { verifier, challenge } = await generatePkcePair();
  const authUrl = buildAuthorizationUrl(provider, clientId, redirectUri, challenge);
  const redirectUrl = await launchWebAuthFlow(authUrl);

  const redirectParams = new URL(redirectUrl).searchParams;
  const code = redirectParams.get("code");
  if (!code) {
    throw new Error(redirectParams.get("error") ?? "calendar authorization did not return a code");
  }

  const config = PROVIDER_CONFIG[provider];
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetchImpl(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(CALENDAR_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
  const tokens = (await response.json()) as TokenResponse;
  if (!tokens.refresh_token) throw new Error("provider did not return a refresh token");

  return {
    provider,
    clientId,
    clientSecret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

async function refreshAccessToken(connection: CalendarConnection, fetchImpl: typeof fetch): Promise<string | null> {
  const config = PROVIDER_CONFIG[connection.provider];
  const body = new URLSearchParams({
    client_id: connection.clientId,
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  });
  if (connection.clientSecret) body.set("client_secret", connection.clientSecret);

  try {
    const response = await fetchImpl(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(CALENDAR_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const tokens = (await response.json()) as TokenResponse;
    return tokens.access_token;
  } catch {
    return null;
  }
}

/**
 * Best-effort: any failure (expired token that won't refresh, network
 * error, no matching event) resolves to null rather than throwing, per
 * the "never block a recording" rule — callers never need a try/catch.
 */
export async function findCurrentEvent(
  connection: CalendarConnection,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEvent | null> {
  try {
    let accessToken = connection.accessToken;
    if (new Date(connection.expiresAt).getTime() <= Date.now()) {
      const refreshed = await refreshAccessToken(connection, fetchImpl);
      if (!refreshed) return null;
      accessToken = refreshed;
    }

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 999);

    const config = PROVIDER_CONFIG[connection.provider];
    const response = await fetchImpl(config.eventsUrl(dayStart.toISOString(), dayEnd.toISOString()), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(CALENDAR_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const events = config.parseEvents(await response.json());
    const nowMs = now.getTime();
    return (
      events.find((event) => new Date(event.startsAt).getTime() <= nowMs && nowMs <= new Date(event.endsAt).getTime()) ??
      null
    );
  } catch {
    return null;
  }
}
