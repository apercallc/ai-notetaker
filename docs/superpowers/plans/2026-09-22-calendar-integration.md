# Calendar Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-label a meeting's title and attendees from the user's
Google/Outlook calendar at recording start, extension-only, never
blocking a recording.

**Architecture:** One `calendar.ts` module implementing a shared PKCE
OAuth2 flow (`chrome.identity.launchWebAuthFlow`) and per-provider REST
config for Google Calendar and Microsoft Graph. `BackgroundController.startRecording`
calls it once, best-effort, before creating the meeting record.

**Tech Stack:** `chrome.identity` (new permission), Web Crypto
(`crypto.subtle`) for PKCE, no new npm dependency.

**Spec:** `docs/superpowers/specs/2026-09-22-calendar-integration-design.md`

## Global Constraints

- Never block, delay noticeably, or fail `startRecording` because of a
  calendar problem — every calendar call is best-effort and swallows its
  own errors.
- Tokens live in `chrome.storage.local` only, never `.sync`.
- No project-owned OAuth client — Client ID/Secret are user-supplied
  settings fields, same shape as an API key.
- No call to a transcription/LLM provider from this code — this is
  extension-only metadata enrichment.

---

### Task 1: `calendar.ts` — types, PKCE, and provider config

**Files:**
- Create: `extension/src/lib/calendar.ts`
- Test: `extension/tests/calendar.test.ts`
- Modify: `extension/tests/setup.ts` (add `chrome.identity` mock)
- Modify: `extension/manifest.json` (add `identity` permission)

**Interfaces:**
- Produces: `CalendarEvent { title: string; attendees: string[]; startsAt: string; endsAt: string }`,
  `CalendarConnection { provider: "google" | "outlook"; clientId: string; clientSecret?: string; accessToken: string; refreshToken: string; expiresAt: string }`,
  `generatePkcePair(): Promise<{ verifier: string; challenge: string }>`,
  `buildAuthorizationUrl(provider, clientId, redirectUri, challenge): string`,
  `exchangeCodeForTokens(provider, clientId, clientSecret, code, verifier, redirectUri): Promise<{ accessToken, refreshToken, expiresAt }>`,
  `connectCalendar(provider, clientId, clientSecret): Promise<CalendarConnection>`,
  `findCurrentEvent(connection): Promise<CalendarEvent | null>` (handles
  silent refresh internally). Task 2 depends on `connectCalendar` and
  `findCurrentEvent`'s exact signatures.

- [ ] **Step 1: Add the `chrome.identity` mock to `tests/setup.ts`**

Add to the `chromeMock` object (alongside `storage`/`runtime`):

```typescript
  identity: {
    launchWebAuthFlow: vi.fn(),
  },
```

And to `reset()`:

```typescript
    this.identity.launchWebAuthFlow.mockReset();
```

- [ ] **Step 2: Add the `identity` permission**

In `extension/manifest.json`, add `"identity"` to the `permissions` array
(alongside `storage`, `nativeMessaging`, `alarms`).

- [ ] **Step 3: Write the failing PKCE test**

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { chromeMock } from "./setup";
import { generatePkcePair } from "../src/lib/calendar";

beforeEach(() => chromeMock.reset());

describe("generatePkcePair", () => {
  it("produces a verifier and a distinct S256 challenge", async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
    // base64url alphabet only, no padding
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a different verifier each call", async () => {
    const first = await generatePkcePair();
    const second = await generatePkcePair();
    expect(first.verifier).not.toBe(second.verifier);
  });
});
```

Run: `cd extension && npx vitest run tests/calendar.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/calendar'`.

- [ ] **Step 4: Implement `calendar.ts`'s types, PKCE, and provider config**

```typescript
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

interface ProviderConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  eventsUrl: (dayStartIso: string, dayEndIso: string) => string;
  parseEvents: (body: unknown) => CalendarEvent[];
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

const PROVIDER_CONFIG: Record<"google" | "outlook", ProviderConfig> = {
  google: {
    authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    eventsUrl: (dayStartIso, dayEndIso) =>
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(dayStartIso)}&timeMax=${encodeURIComponent(dayEndIso)}`,
    parseEvents: (body) => {
      const items = (body as { items?: unknown[] }).items ?? [];
      return items.map((raw) => {
        const item = raw as Record<string, any>;
        return {
          title: item.summary ?? "",
          attendees: (item.attendees ?? [])
            .map((a: Record<string, string>) => a.displayName || a.email)
            .filter(Boolean),
          startsAt: item.start?.dateTime ?? item.start?.date,
          endsAt: item.end?.dateTime ?? item.end?.date,
        };
      });
    },
  },
  outlook: {
    authEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Calendars.Read offline_access",
    eventsUrl: (dayStartIso, dayEndIso) =>
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(dayStartIso)}&endDateTime=${encodeURIComponent(dayEndIso)}`,
    parseEvents: (body) => {
      const items = (body as { value?: unknown[] }).value ?? [];
      return items.map((raw) => {
        const item = raw as Record<string, any>;
        return {
          title: item.subject ?? "",
          attendees: (item.attendees ?? [])
            .map((a: Record<string, any>) => a.emailAddress?.name || a.emailAddress?.address)
            .filter(Boolean),
          startsAt: item.start?.dateTime,
          endsAt: item.end?.dateTime,
        };
      });
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
```

Run: `cd extension && npx vitest run tests/calendar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/calendar.ts extension/tests/calendar.test.ts extension/tests/setup.ts extension/manifest.json
git commit -m "feat: add calendar PKCE + provider config scaffolding"
```

---

### Task 2: Token exchange, refresh, and event lookup

**Files:**
- Modify: `extension/src/lib/calendar.ts`
- Modify: `extension/tests/calendar.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_CONFIG`, `generatePkcePair`, `buildAuthorizationUrl` (Task 1).
- Produces: `connectCalendar`, `findCurrentEvent` (final signatures from the spec).

- [ ] **Step 1: Write the failing connect-flow test**

```typescript
describe("connectCalendar", () => {
  it("launches the auth flow, exchanges the code, and returns a connection", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation((_details, callback) => {
      callback(`https://example.chromiumapp.org/?code=fake-auth-code`);
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
    })) as unknown as typeof fetch;

    const connection = await connectCalendar("google", "client-id", "client-secret", fetchImpl);

    expect(connection.provider).toBe("google");
    expect(connection.accessToken).toBe("access-1");
    expect(connection.refreshToken).toBe("refresh-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects when the auth flow returns no code", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation((_details, callback) => {
      callback(`https://example.chromiumapp.org/?error=access_denied`);
    });
    await expect(connectCalendar("google", "client-id", "client-secret", vi.fn())).rejects.toThrow();
  });
});
```

Run: `cd extension && npx vitest run tests/calendar.test.ts`
Expected: FAIL — `connectCalendar` not exported yet.

- [ ] **Step 2: Implement `connectCalendar`**

```typescript
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
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
  const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };

  return {
    provider,
    clientId,
    clientSecret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}
```

Run: `cd extension && npx vitest run tests/calendar.test.ts`
Expected: PASS

- [ ] **Step 3: Write the failing refresh + event-lookup tests**

```typescript
describe("findCurrentEvent", () => {
  const baseConnection = {
    provider: "google" as const,
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: "stale-access-token",
    refreshToken: "refresh-1",
    expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
  };

  it("refreshes an expired token before fetching events", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "fresh-token", expires_in: 3600 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            summary: "Team sync",
            attendees: [{ displayName: "Alex", email: "alex@example.com" }],
            start: { dateTime: new Date(Date.now() - 60_000).toISOString() },
            end: { dateTime: new Date(Date.now() + 60_000).toISOString() },
          }],
        }),
      });

    const event = await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }));
    expect(event?.title).toBe("Team sync");
    expect(event?.attendees).toEqual(["Alex"]);
  });

  it("returns null when no event contains the current time", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "fresh-token", expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    expect(await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null (never throws) when the refresh call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("does not refresh a still-valid token", async () => {
    const validConnection = { ...baseConnection, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    await findCurrentEvent(validConnection, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

Run: `cd extension && npx vitest run tests/calendar.test.ts`
Expected: FAIL — `findCurrentEvent` not exported yet.

- [ ] **Step 4: Implement token refresh and `findCurrentEvent`**

```typescript
async function refreshAccessToken(
  connection: CalendarConnection,
  fetchImpl: typeof fetch,
): Promise<string | null> {
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
    });
    if (!response.ok) return null;
    const tokens = (await response.json()) as { access_token: string };
    return tokens.access_token;
  } catch {
    return null;
  }
}

/** Best-effort: any failure (expired token that won't refresh, network
 * error, no matching event) resolves to null rather than throwing, per
 * the "never block a recording" rule — callers must not need a try/catch. */
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
```

Run: `cd extension && npx vitest run tests/calendar.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/calendar.ts extension/tests/calendar.test.ts
git commit -m "feat: add calendar token exchange, silent refresh, and event lookup"
```

---

### Task 3: Wire into settings, storage, and recording start

**Files:**
- Modify: `extension/src/types.ts` (`NotetakerSettings.calendar`, `MeetingRecord.attendees`)
- Modify: `extension/src/lib/backgroundController.ts` (`startRecording`)
- Modify: `extension/tests/backgroundController.test.ts`
- Modify: `extension/src/settings/settings.ts` (connect/disconnect UI)

**Interfaces:**
- Consumes: `connectCalendar`, `findCurrentEvent`, `CalendarConnection` (Task 2).

- [ ] **Step 1: Add the type fields**

In `types.ts`:

```typescript
export interface MeetingRecord {
  // ...existing fields...
  attendees?: string[];
}
```

```typescript
export interface NotetakerSettings {
  // ...existing fields...
  calendar: CalendarConnection | null;
}

export const DEFAULT_SETTINGS: NotetakerSettings = {
  // ...existing fields...
  calendar: null,
};
```

(Import `CalendarConnection` from `./lib/calendar`.)

- [ ] **Step 2: Write the failing `startRecording` calendar tests**

Add to `tests/backgroundController.test.ts`, following its established
`createFakeClient()`/`saveSettings()` pattern — read the file's top
section first for exact helper names. Mock `../src/lib/calendar`'s
`findCurrentEvent` via `vi.mock`:

```typescript
vi.mock("../src/lib/calendar", () => ({ findCurrentEvent: vi.fn() }));
import { findCurrentEvent } from "../src/lib/calendar";

// ...in the relevant describe block:
it("titles the meeting from the matching calendar event when one is connected", async () => {
  vi.mocked(findCurrentEvent).mockResolvedValue({
    title: "Roadmap sync",
    attendees: ["Alex", "Sam"],
    startsAt: new Date().toISOString(),
    endsAt: new Date().toISOString(),
  });
  const client = createFakeClient();
  const controller = new BackgroundController(client, vi.fn());
  await controller.init();
  await controller.saveSettings({
    ...DEFAULT_SETTINGS,
    consentDisclosureAcknowledged: true,
    calendar: { provider: "google", clientId: "x", accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });

  const meetingId = await controller.startRecording();
  const meeting = await getMeeting(meetingId);

  expect(meeting?.title).toBe("Roadmap sync");
  expect(meeting?.attendees).toEqual(["Alex", "Sam"]);
});

it("falls back to the default title when no calendar is connected", async () => {
  vi.mocked(findCurrentEvent).mockResolvedValue(null);
  const client = createFakeClient();
  const controller = new BackgroundController(client, vi.fn());
  await controller.init();
  await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true });

  const meetingId = await controller.startRecording();
  const meeting = await getMeeting(meetingId);

  expect(meeting?.title).toContain("Meeting on");
  expect(meeting?.attendees).toBeUndefined();
});

it("falls back to the default title when the calendar lookup throws", async () => {
  vi.mocked(findCurrentEvent).mockRejectedValue(new Error("network error"));
  const client = createFakeClient();
  const controller = new BackgroundController(client, vi.fn());
  await controller.init();
  await controller.saveSettings({
    ...DEFAULT_SETTINGS,
    consentDisclosureAcknowledged: true,
    calendar: { provider: "google", clientId: "x", accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });

  const meetingId = await controller.startRecording();
  const meeting = await getMeeting(meetingId);
  expect(meeting?.title).toContain("Meeting on");
});
```

Run: `cd extension && npx vitest run tests/backgroundController.test.ts`
Expected: FAIL — `startRecording` doesn't consult the calendar yet, so
the first two assertions get the default title/`undefined` attendees in
both cases.

- [ ] **Step 3: Wire the lookup into `startRecording`**

In `backgroundController.ts`, import `findCurrentEvent` and change the
meeting-construction block:

```typescript
    const meetingId = generateMeetingId();
    let title = `Meeting on ${new Date().toLocaleString()}`;
    let attendees: string[] | undefined;
    if (this.settings.calendar) {
      try {
        const event = await findCurrentEvent(this.settings.calendar);
        if (event) {
          if (event.title) title = event.title;
          if (event.attendees.length > 0) attendees = event.attendees;
        }
      } catch {
        // Calendar enrichment is best-effort — never block a recording on it.
      }
    }
    const meeting: MeetingRecord = {
      id: meetingId,
      title,
      startedAt: new Date().toISOString(),
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: meetingMode,
      status: "recording",
      ...(attendees ? { attendees } : {}),
    };
```

(Match the exact surrounding variable names already in this function —
read the current file before editing, since this plan's snippet
elides unrelated lines.)

Run: `cd extension && npx vitest run tests/backgroundController.test.ts`
Expected: PASS

- [ ] **Step 4: Add the settings UI**

Read `extension/src/settings/settings.ts` in full first to match its
existing render/save patterns exactly (see how `renderKeyField` and the
save handler at the bottom of the file work). Add a "Calendar" section:
a provider `<select>` (none/Google/Outlook), Client ID + Client Secret
text inputs (secret only shown for Google), a Connect/Disconnect button
whose click handler calls `connectCalendar` (Task 2) and, on success,
saves the returned `CalendarConnection` into settings via the existing
`saveSettings` flow; on failure, shows an inline error using this file's
existing error-display convention. A connected state shows "Connected to
Google Calendar" / "Connected to Outlook Calendar" with a Disconnect
button that sets `calendar: null`.

- [ ] **Step 5: Run the full extension suite, typecheck, and build**

Run: `cd extension && npm test && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/types.ts extension/src/lib/backgroundController.ts extension/tests/backgroundController.test.ts extension/src/settings/settings.ts
git commit -m "feat: prefill meeting title/attendees from a connected calendar at recording start"
```

---

### Task 4: Docs, guardrails review, and TODO update

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `TODO.md`

- [ ] **Step 1: Add a "Connect your calendar" section to `docs/getting-started.md`**

Document: this is optional; the user registers their own free Google
Cloud or Azure AD OAuth app (link to each provider's app-registration
docs), sets the redirect URI to the value shown in the extension's
settings page (`chrome.identity.getRedirectURL()`'s output — link out to
`https://developers.google.com/identity/protocols/oauth2` /
`https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app`
rather than duplicating provider-specific steps that could drift), pastes
the Client ID (and, for Google, Client Secret) into settings, and clicks
Connect.

- [ ] **Step 2: Run the `notetaker-guardrails-reviewer` agent**

This touches `extension/` (new OAuth flow, new stored credential shape,
new permission) — dispatch the guardrails reviewer against the diff
since this sub-project's first commit before considering it done.
Specifically confirm: tokens only ever land in `chrome.storage.local`
(never `.sync`), no call reaches a transcription/LLM provider, and the
`identity` permission's addition doesn't silently widen anything else.

- [ ] **Step 3: Update `TODO.md`**

Find:

```
- [ ] Calendar integration (Google Calendar / Outlook) to auto-label
      meetings and pre-fill attendees
```

Replace with:

```
- [x] Calendar integration — extension-only (metadata enrichment, not AI
      pipeline work). BYOK OAuth per user via chrome.identity.launchWebAuthFlow
      + PKCE, not a project-owned OAuth client (avoids Google's consent-
      screen verification requirement entirely). Best-effort: any failure
      falls back to today's default title with no attendees, never blocks
      a recording. See
      `docs/superpowers/specs/2026-09-22-calendar-integration-design.md`.
      A live OAuth popup and real Google/Microsoft account responses
      remain release-owner/manual verification — no such account exists
      in this sandbox.
```

- [ ] **Step 4: Commit**

```bash
git add docs/getting-started.md TODO.md
git commit -m "docs: add calendar setup instructions, mark calendar integration done"
```
