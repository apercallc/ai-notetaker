# Calendar Integration Design

Date: 2026-09-22
Status: Approved, implementation in progress

## Problem

TODO.md sub-project 3 lists: "Calendar integration (Google Calendar /
Outlook) to auto-label meetings and pre-fill attendees." Today
`BackgroundController.startRecording` (`extension/src/lib/backgroundController.ts`)
always titles a new meeting `Meeting on ${new Date().toLocaleString()}`
with no attendee information, even when the user is clearly in a
calendared meeting at that exact moment.

## Goals

- When the user starts recording during a calendared event, the meeting
  is titled from that event and its attendee list is captured.
- Support both Google Calendar and Microsoft/Outlook Calendar.
- Never block or fail a recording because of a calendar problem — this
  is enrichment, not a dependency.

## Non-goals

- Auto-starting a recording when a calendar event begins. Out of scope —
  the user still clicks "Start Recording" themselves (matches the
  existing consent-first design; silently auto-recording a calendared
  meeting the user never explicitly started would be a consent problem,
  not just a scope question).
- Writing anything back to the user's calendar (no RSVP, no created
  events). Read-only integration only.
- Historical backfill of past meetings' titles from calendar history.
- A generic "calendar provider" plugin system for providers beyond
  Google/Outlook. Two providers, one shared OAuth+REST shape — YAGNI
  beyond that.

## Architecture

### Where this lives: the extension, not the helper

This is metadata enrichment of a meeting record the extension already
creates locally (`saveMeeting` in `backgroundController.ts`), not AI
pipeline work — it doesn't touch transcription, summarization, or any
provider the helper talks to. It belongs entirely in `extension/`,
consistent with the existing pattern of extension-owned local meeting
metadata. The helper needs zero changes.

### Auth model: BYOK OAuth app, not a project-owned one

Consistent with this project's BYOK philosophy (the user already
registers their own Deepgram/Claude/Groq/Gemini/DeepSeek API keys), the
user registers their own tiny personal OAuth app with Google Cloud
Console or Azure AD and pastes its Client ID (and Client Secret, for
Google) into the extension's settings — the same shape as pasting a
provider API key.

This is a deliberate choice over a project-owned shared OAuth client,
for a concrete reason: Google requires a verified OAuth consent screen
for the `calendar.readonly` scope once an app is used by real users
outside a fixed "Testing" list of up to 100 accounts. A shared
project-owned client would need this project to complete Google's
verification review (privacy policy, homepage, demo video — real,
ongoing release-owner work with no clear completion date) before *any*
user could connect their calendar without an "unverified app" scare
screen. A user's own personal OAuth app never needs verification: they
are its only test user, forever. This sidesteps an external gate
entirely rather than adding one — the same reasoning that already
governs the BYOK API key model.

`chrome.identity.getAuthToken` (Chrome's built-in Google-only flow) was
considered and rejected for this reason: it requires the Client ID to be
baked into `manifest.json` at build time, which forces a single
project-owned client and reintroduces the verification problem.
`chrome.identity.launchWebAuthFlow` is used instead — a generic OAuth2
popup flow that accepts a fully dynamic, runtime-provided authorization
URL, so it works identically for a user-supplied Google or Microsoft
client and needs no manifest-time configuration.

### OAuth flow (PKCE, both providers share one code path)

1. Settings page: user picks "Google Calendar" or "Outlook Calendar",
   pastes their Client ID (Google also needs a Client Secret — see
   below; Microsoft "public client" registrations don't use one).
2. "Connect" generates a PKCE code verifier/challenge (S256,
   `crypto.subtle.digest`, no new dependency), builds the provider's
   authorization URL, and calls
   `chrome.identity.launchWebAuthFlow({ url, interactive: true })`. The
   redirect URI is `https://<extension-id>.chromiumapp.org/` — the
   fixed value Chrome provides for every installed extension, which the
   user registers as their OAuth app's redirect URI.
3. The returned redirect URL's `code` query parameter is exchanged for
   an access + refresh token via a direct `fetch` to the provider's
   token endpoint (no server in between).
4. Tokens are stored in `chrome.storage.local` only (never `.sync` — the
   existing project-wide rule for any credential) alongside the
   provider, Client ID, and (for Google) Client Secret.
5. On every calendar lookup, an expired access token is silently
   refreshed via the stored refresh token before use; a refresh failure
   clears the stored connection and surfaces a "reconnect Google/Outlook
   Calendar" state in settings, exactly like an expired API key would.

**Client Secret handling (Google only):** Google's token endpoint
requires a client secret even for installed-app/browser-extension client
types, but explicitly does not treat it as confidential for these types
(Google's own docs: it "cannot be kept confidential" in this context —
the app's identity, not the secret's secrecy, is the boundary). Storing
it in `chrome.storage.local` alongside the Client ID is consistent with
Google's own threat model for this client type. Microsoft's public
client flow needs no secret at all.

### Event matching at recording start

`BackgroundController.startRecording` gains one step: if a calendar
provider is connected, fetch today's events (bounded time window: from
start of day to end of day, one request) and find the event whose
`start`/`end` range contains the current time. If found:

- `title` becomes the event's summary/subject (falls back to the
  existing default title if the event has no title).
- A new `attendees?: string[]` field (email or display name per
  provider's response shape) is set on the `MeetingRecord`.

Any failure at any step (not connected, token refresh failure, network
error, no matching event) falls back to today's exact behavior — a
default-titled meeting with no attendees — and never blocks or delays
`startRecording`. A slow calendar API call must not delay the "Start
Recording" button's response, so the lookup is time-boxed (existing
project convention: provider calls use bounded timeouts, matching the
helper's `provider_client()` connect/request timeout pattern) and its
failure path is silent (no error surfaced to the user for an enrichment
feature — only a real recording failure is user-visible).

### Provider abstraction

One `extension/src/lib/calendar.ts` module, not two separate provider
files, since both providers share the exact same OAuth2 + REST shape
and differ only in fixed config:

```typescript
interface CalendarProviderConfig {
  id: "google" | "outlook";
  authEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  eventsUrl: (dayStartIso: string, dayEndIso: string) => string;
  parseEvents: (body: unknown) => CalendarEvent[]; // normalizes each provider's distinct JSON shape
}
```

## Data model changes

- `extension/src/types.ts`: `MeetingRecord` gains `attendees?: string[]`.
- `NotetakerSettings` gains `calendar: CalendarConnection | null`, where
  `CalendarConnection` holds `{ provider: "google" | "outlook", clientId: string,
  clientSecret?: string, accessToken: string, refreshToken: string,
  expiresAt: string }`. Lives in `chrome.storage.local` exactly like
  `apiKeys` today — no new storage mechanism.

## Testing

- `calendar.ts`: unit tests mocking `chrome.identity.launchWebAuthFlow`
  and global `fetch` — the PKCE challenge generation, the authorization
  URL shape per provider, token exchange, silent refresh-on-expiry, and
  each provider's event-list response parsing into the shared
  `CalendarEvent` shape.
- `backgroundController.ts`: tests proving `startRecording` still
  succeeds with a default title when no calendar is connected, when the
  calendar lookup throws, and when no event matches "now" — and that it
  uses the matched event's title/attendees when one does. No live Google/
  Microsoft account exists in this sandbox, so the real end-to-end OAuth
  popup and live API responses remain release-owner/manual verification,
  the same category as this project's other unverifiable-in-sandbox
  gates (documented in TODO.md).
- Settings UI: tests for the connect/disconnect flow and the
  "reconnect" state after a simulated refresh failure.

## Rollout

No feature flag — `calendar: null` (the default) means the feature is
simply inactive until a user opts in via settings, identical in spirit
to how an unset API key means a provider is unavailable rather than
broken.
