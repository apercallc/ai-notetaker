# extension/ — Chrome Extension

Manifest V3. This package is a **thin UI only** — it displays what the
helper streams to it and forwards user actions (start/stop recording,
settings) down to the helper. See the root `CLAUDE.md` and
`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md` (§3.2)
for why: service workers die after ~30s idle and can't own a pipeline that
needs to run for a 45-minute meeting.

## Conventions

- **Helper communication is Native Messaging only.** Never open a raw
  WebSocket to `127.0.0.1` for extension↔helper control — any webpage's JS
  can connect to an open local port. Native Messaging is OS-enforced and
  allowlisted to this extension's ID.
- **API keys and tokens live in `chrome.storage.local`, never `.sync`.**
  `.sync` ships data to Google's sync servers — unacceptable for secrets.
- **Do not call transcription/LLM provider APIs directly from the
  extension.** That's the helper's job. If you find yourself importing an
  API client for Deepgram/Claude/etc. here, stop — the request should go to
  the helper over Native Messaging instead.
- **No accounts, no login, no telemetry to a project-operated server.**
  The only outbound sync target is the user's own self-hosted webapp URL,
  which they configure themselves — never a default/hardcoded endpoint.
- Keep it a standard WebExtension where the API allows, even though Chrome
  is the primary target — an Edge/Brave/Firefox port later shouldn't
  require a rewrite (see spec §7).
