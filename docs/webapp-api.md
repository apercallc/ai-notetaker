# Webapp Ingestion and Managed Processing API

This document covers two additive contracts:

- `/api/meetings` is the existing self-hosted BYOK ingestion API.
- `/api/v1/*` is the authenticated managed-service API used by the extension
  and helper when the user selects hosted AI.
- `/api/v1/desktop-sync/*` is optional text-only sync from the Tauri desktop
  app, authenticated by a revocable user token bound to one workspace.

Local BYOK recording does not require an account or either API.

Every private API request (reads included — see the architecture spec §3.5
and root `CLAUDE.md`) must authenticate its caller. Browser pages use their
session cookie; managed APIs retain their established client/session auth;
legacy self-hosted ingestion uses its `AUTH_TOKEN`.
Desktop sync uses a hashed, revocable `desktop_notes_sync` token created in
the signed-in web app at Settings → Integrations. The token is bound to that
user's active workspace; the route rechecks membership on each request. Keep
it in the desktop operating-system credential vault. `GET /api/health` stays
public for setup diagnostics; no workspace-note route is anonymous.

### Desktop note sync

The local BYOK desktop path does not need an account. Sync is explicitly
optional. It sends completed note text to one selected workspace and imports
workspace notes as local copies. It never sends audio, provider keys, or local
file paths. A durable local outbox retries failed uploads after restart; an
updatedAt/id cursor resumes note imports. Desktop uploads include the server
version last acknowledged for each note. The API rejects stale writes with
HTTP 409 and accepts an identical retry after a lost response, so an online
edit is not silently overwritten. First uploads create a note or accept an
identical already-created note. Local imports skip existing IDs. Web edits and
deletions are not yet propagated into desktop copies, and settings are not
synchronized.

`GET /api/v1/desktop-sync` checks the token and returns its bound workspace:

```json
{ "ok": true, "workspace": { "id": "...", "name": "Product" } }
```

`POST /api/v1/desktop-sync/meetings` accepts the same finished-note body as
`POST /api/meetings`, including optional transcript timestamps. Missing times
remain null and segment order is preserved; clients must not fabricate timing.
Desktop clients send `X-Desktop-Sync-Version: new` for first uploads or the
last acknowledged `updatedAt` value for later uploads. Stale versions return
HTTP 409 and leave the local outbox item queued for review/retry. Clients that
omit this header retain the legacy upsert behavior during the migration window.
The route ignores browser CORS handling and authenticates the desktop token
itself. It is available on managed and self-hosted hosting.

`GET /api/v1/desktop-sync/meetings` returns up to 50 notes ordered by
`updatedAt` and ID. Pass both `updatedAt` and `id` from `nextCursor` to fetch
the next page. On a later sync, the desktop requests a one-second overlap by
passing only `updatedAt`; duplicate local IDs are skipped. Every page is
scoped to the token workspace and excludes trash. The desktop stores the
cursor only after it has safely imported that page.

### `GET /api/health`

The self-hosted/BYOK response remains backwards-compatible:

```json
{ "ok": true }
```

When `MANAGED_HOSTING=true`, the response also exposes non-secret release
readiness diagnostics:

```json
{
  "ok": true,
  "mode": "managed",
  "managedReady": true,
  "objectStorage": "s3"
}
```

`managedReady: false` means one or more required worker, provider, Stripe,
application URL, or shared private R2/S3 staging settings are missing. It never
includes secret values. The filesystem object backend is valid for local or
single-node self-hosted deployments; managed production must report `r2` or
`s3`. Audio objects are deleted after successful processing or expire within
24 hours; hosted meeting APIs expose text notes, not recordings.

Managed `/api/v1/*` requests from the extension are CORS-allowed only for the
fixed Chrome extension origin (`chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok`)
or the explicitly configured `MANAGED_EXTENSION_ORIGIN` for a controlled
fork. Unknown browser origins receive a 403 preflight response; the service
does not use `Access-Control-Allow-Origin: *` for bearer-authenticated APIs.

## Endpoints

### Managed API (`/api/v1`)

Managed routes require a real per-user session id in
`Authorization: Bearer <session-id>`. The deploy-time `AUTH_TOKEN` is not a
managed workspace identity and is rejected on these routes.

Managed clients may also send `X-Workspace-Id: <workspace-id>` when the
account belongs to more than one workspace. The server accepts the requested
workspace only after validating membership; when the header is absent, the
user's default workspace is used. The extension and helper send this header
for every managed upload, processing, and job-status request.

- `POST /api/v1/auth/login` — exchange an email/password for a short-lived
  opaque session id and workspace/plan metadata.
- `POST /api/v1/auth/google/exchange` — exchange a one-use Google OAuth
  handoff code and PKCE verifier for the same extension session response.
  Extension OAuth starts at `/api/google/oauth/start` with the fixed extension
  redirect URI, an S256 challenge and random client state. The callback puts
  only the short-lived code and state in the redirect fragment; the bearer
  token is returned only by this authenticated exchange response. Google
  account linking for Calendar/Drive remains a separate flow.
- `GET /api/v1/entitlements` — read the server-authoritative plan, payment
  status, usage, and remaining meeting/audio allowance before starting
  capture. `warning` is `none`, `low`, or `exhausted`; the nested `audio`
  object reports audio seconds and its warning separately.
- `POST /api/v1/meetings` — create the workspace-scoped meeting shell before
  audio upload.
- `POST /api/v1/uploads` — create or replay an idempotent upload manifest. An
  incomplete session expires after 24 hours; reusing the same idempotency key
  after expiry creates a fresh session after private chunk cleanup.
- `PUT /api/v1/uploads/:uploadId/chunks/:chunkIndex` — upload one checksummed
  `application/octet-stream` chunk with `x-audio-channel: mic|speaker`.
- `POST /api/v1/uploads/:uploadId/complete` — verify all chunks and byte
  totals before processing.
- `POST /api/v1/meetings/:meetingId/process` — reserve one metered processing
  unit and enqueue an idempotent job.
- `GET /api/v1/jobs/:jobId` — read job status within the current workspace.
- `POST /api/v1/billing/checkout` — owner-only Stripe Checkout session for an
  allowlisted hosted price.
- `POST /api/v1/billing/portal` — owner-only Stripe customer portal session.
- `POST /api/v1/billing/webhook` — Stripe-signed subscription updates; event
  ids are stored so Stripe retries are safe.

### File import (`/api/import`, browser only)

The `/import` page uploads one audio or video file for transcription and
summary. These routes authenticate with the browser's HttpOnly `session`
cookie, not a Bearer token, so they also require an `Origin` equal to the
app's own origin and the `x-notetaker-browser: 1` header (a CSRF defence a
Bearer API does not need). The workspace is the session's active workspace.

- `POST /api/import` — register the meeting and an idempotent `kind=import`
  upload manifest. Body: `meetingId`, `idempotencyKey`, `fileName`,
  `totalBytes`, and optional `durationSeconds` (browser-measured estimate),
  `title`, `recordedAtMs`. Returns `uploadId`, `totalChunks`, `chunkBytes` and
  `receivedChunks` so a reload resumes. Refused with 402 when the plan cannot
  cover the estimate, and a refused request leaves no empty meeting behind.
- `PUT /api/import/:uploadId/chunks/:chunkIndex` — one checksummed 4 MiB slice
  (`x-chunk-sha256`). Only import uploads in the caller's workspace are
  accepted here.
- `POST /api/import/:uploadId/complete` — seal the upload, reserve usage and
  queue the job.

Usage: an import is one meeting unit plus its **full duration** in audio
seconds (a mono hour counts as an hour, unlike the two-channel live-capture
formula). The first reservation uses the browser's duration (with a size-based
floor); after decoding, the worker replaces it with the measured length
*before any provider call*, and fails the job and refunds if that exceeds the
plan's remaining audio hours. Limits per file are `PLAN_IMPORT_MAX_SECONDS` in
`webapp/src/lib/plans.ts`. Files are decoded by sandboxed `ffmpeg`
(`webapp/src/lib/mediaDecode.ts`); the staged original is deleted when notes
are saved or after 24 hours.

The worker-only `POST /api/v1/jobs/:jobId/run` route requires the server-side
`MANAGED_WORKER_TOKEN` and `x-workspace-id`; it is never called by the
extension. The process route dispatches this worker automatically when the
token is configured; an external scheduler can retry queued/error jobs too.
Provider credentials are server environment secrets, not request fields.
The browser UI exposes the same purchase and portal flow at `/billing`.

The authenticated browser meeting page can create workspace-scoped
share capabilities that expire after 1 to 365 days or never (`expiresAt` is null). Share links are served at `/share/:token`; the token is
stored only as a SHA-256 hash, and the read-only page exposes meeting notes
without requiring the recipient to have an account. The owner/workspace can
revoke a link at any time; deleting the note ends it too. Share links contain notes only and never
expose the temporary audio used during processing.

### `POST /api/meetings`

Create/ingest a finished meeting note. Idempotent on `id` (a repeat POST
with the same `id` upserts rather than duplicating).

```jsonc
// Request
{
  "id": "<uuid, same as the meetingId used in the Native Messaging protocol>",
  "title": "string, optional (e.g. calendar event title, or a default like 'Meeting on <date>')",
  "mode": "general" | "standup" | "sales" | "one_on_one" | "interview" | "custom",
  "startedAt": "<ISO 8601>",
  "endedAt": "<ISO 8601>",
  "transcript": [{ "speaker": "you" | "them" | "them-2", "text": "...", "timestamp": "<ISO 8601> | null" }],
  "summary": "string",
  "captureSource": "desktop" | "meet", // optional; managed Meet registration sends "meet"
  "processingMode": "local_byok" | "managed", // optional; preserved on legacy re-sync when omitted
  "actionItems": [{
    "id": "stable action id, optional for older clients",
    "text": "...",
    "owner": "string, optional",
    "status": "open" | "done",
    "dueAt": "<ISO 8601> | null",
    "completedAt": "<ISO 8601> | null"
  }]
}

// Response: 201 Created, body echoes the stored record
```

### `GET /api/meetings?query=&limit=&offset=`

List/search meetings, newest first. `query` substring-searches title, summary,
transcript text, and action-item text. `limit` defaults to 20 and is capped at 100; `offset`
defaults to 0. Both must be non-negative integers when provided.

```jsonc
// Response
{ "meetings": [{ "id": "...", "title": "...", "startedAt": "...", "summaryPreview": "...", "openActionItems": 3 }], "total": 42 }
```

### `GET /api/meetings/:id`

Full detail for one meeting (transcript, summary, action items).

The browser UI also exposes `/actions`, an authenticated cross-meeting inbox
where the user can filter open/completed items, mark them done, and set due
dates. Those edits remain in the self-hosted webapp and are reflected on the
meeting detail page.

### `DELETE /api/meetings/:id`

Delete a meeting. No soft-delete requirement for v1 — self-hosted, single
user, the user owns their own deletion decisions.

## Data model note

Every table carries `user_id`/`workspace_id` from day one (see spec §3.5,
§7) even though v1 auth is a single shared token with no real multi-user
concept yet — this is intentionally structured for a schema-migration-free
future.
