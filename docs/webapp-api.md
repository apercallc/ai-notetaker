# Webapp Ingestion API

This is the contract between any client (the extension, and later the
mobile apps) and a self-hosted `webapp/` instance. It's additive/optional —
nothing in the product requires this API to exist.

Every request (reads included — see the architecture spec §3.5 and the
non-negotiable constraint in root `CLAUDE.md`) must include:

```
Authorization: Bearer <token>
```

The token is generated once when the user deploys their webapp instance
and pasted into the extension's settings. There is no unauthenticated
route in this API, ever — a 401 is the correct response to a missing or
wrong token on any endpoint, including `GET /api/health`... actually
`GET /api/health` is the one deliberate exception (returns `{ "ok": true }`
with no auth, purely so the extension's settings page can validate
"is this URL even a webapp instance" before asking for a token) — every
other route requires auth.

## Endpoints

### `POST /api/meetings`

Create/ingest a finished meeting note. Idempotent on `id` (a repeat POST
with the same `id` upserts rather than duplicating).

```jsonc
// Request
{
  "id": "<uuid, same as the meetingId used in the Native Messaging protocol>",
  "title": "string, optional (e.g. calendar event title, or a default like 'Meeting on <date>')",
  "startedAt": "<ISO 8601>",
  "endedAt": "<ISO 8601>",
  "transcript": [{ "speaker": "you" | "them" | "them-2", "text": "...", "timestamp": "<ISO 8601>" }],
  "summary": "string",
  "actionItems": [{ "text": "...", "owner": "string, optional" }]
}

// Response: 201 Created, body echoes the stored record
```

### `GET /api/meetings?query=&limit=&offset=`

List/search meetings, newest first. `query` full-text searches title,
summary, and transcript text.

```jsonc
// Response
{ "meetings": [{ "id": "...", "title": "...", "startedAt": "...", "summaryPreview": "..." }], "total": 42 }
```

### `GET /api/meetings/:id`

Full detail for one meeting (transcript, summary, action items).

### `DELETE /api/meetings/:id`

Delete a meeting. No soft-delete requirement for v1 — self-hosted, single
user, the user owns their own deletion decisions.

## Data model note

Every table carries `user_id`/`workspace_id` from day one (see spec §3.5,
§7) even though v1 auth is a single shared token with no real multi-user
concept yet — this is intentionally structured for a schema-migration-free
future.
