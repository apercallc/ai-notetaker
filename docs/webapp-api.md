# Webapp Ingestion and Managed Processing API

This document covers two additive contracts:

- `/api/meetings` is the existing self-hosted BYOK ingestion API.
- `/api/v1/*` is the authenticated managed-service API used by the extension
  and helper when the user selects hosted AI.

Local BYOK recording does not require an account or either API.

Every request (reads included — see the architecture spec §3.5 and the
non-negotiable constraint in root `CLAUDE.md`) must include:

```
Authorization: Bearer <token>
```

The token is generated once when the user deploys their webapp instance
and pasted into the extension's settings. There is no unauthenticated
API route for workspace data. `GET /api/health` is the one deliberate
exception: it is public so the extension's settings page can validate
"is this URL even a webapp instance" before asking for a token. Every other
route requires auth.

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

`managedReady: false` means one or more required worker, provider, Stripe, or
application-URL settings are missing. It never includes secret values. The
filesystem object backend is valid for local or single-node deployments;
multi-instance managed production should report `objectStorage: "s3"`.

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
- `GET /api/v1/entitlements` — read the server-authoritative plan, payment
  status, usage, and remaining processing allowance before starting capture.
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

The worker-only `POST /api/v1/jobs/:jobId/run` route requires the server-side
`MANAGED_WORKER_TOKEN` and `x-workspace-id`; it is never called by the
extension. The process route dispatches this worker automatically when the
token is configured; an external scheduler can retry queued/error jobs too.
Provider credentials are server environment secrets, not request fields.
The browser UI exposes the same purchase and portal flow at `/billing`.

The authenticated browser meeting page can create expiring, workspace-scoped
share capabilities. Share links are served at `/share/:token`; the token is
stored only as a SHA-256 hash, and the read-only page exposes meeting notes
without requiring the recipient to have an account. The owner/workspace can
revoke a link before its expiry. Managed meetings also expose separate
authenticated mic and speaker WAV downloads at
`/meetings/:meetingId/recording?channel=mic|speaker`.

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
  "transcript": [{ "speaker": "you" | "them" | "them-2", "text": "...", "timestamp": "<ISO 8601>" }],
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
