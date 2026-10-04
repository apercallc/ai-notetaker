# AI Notetaker — Desktop-First Product Design

Date: 2026-10-03
Status: Approved direction; migration plan active

This document supersedes the extension-led capture and setup decisions in the
2026-09-24 dual-mode product design. That document remains the record of
existing managed-service contracts and implementation history.

## Product decision

AI Notetaker is a cross-platform Tauri desktop app. The app owns first-run
setup, provider API keys, audio readiness, recording controls, local notes,
recovery, and optional web-app sync. Customers do not need a browser extension
to record a meeting. The optional Chrome extension records Google Meet tab
audio and microphone tracks when a user wants tab-specific capture; the
desktop app processes an imported archive.

The basic path stays local and account-free:

1. Install AI Notetaker once.
2. Choose transcription and summary providers; add and test their API keys.
3. Grant microphone and system-audio access.
4. Start and stop a meeting from the desktop app.
5. Find the transcript, summary, and action items in local meeting history.

Connecting a web app is optional. The desktop client can sync completed
meeting text to a user-configured, authenticated web-app API and open that
library. It never sends provider API keys to the web app. Raw audio remains
local by default. No Google sign-in or hosted-account sign-in is required for
local BYOK.

## Architecture

- The Tauri/Rust app owns capture, provider calls, durable audio, processing,
  local settings, local history, and recovery.
- The existing Rust audio and processing crates remain the shared core.
- The Tauri window calls Rust commands through Tauri IPC. Do not add an open
  TCP or localhost WebSocket listener.
- Capture the default system output and microphone as separate channels using
  each OS's supported capture APIs. The simple default may include non-meeting
  system sounds; show an unmistakable recording indicator and explain the
  capture scope before the first recording.
- Keep raw audio on disk before every provider request. Provider failures must
  leave recordings recoverable.
- Store provider keys with the operating system's credential vault. Keep
  ordinary preferences and meeting records in the app's private data folder.
- Web-app sync is an optional downstream copy of completed notes. Reuse the
  authenticated API contract, retry safely, and never let sync failure
  interrupt capture or local processing.
- The system tray is a secondary status surface, not the only place to
  configure the product or start a recording.

## Capture boundaries

- Support macOS 13+ on arm64 and x86_64, Windows 64-bit, and Debian/Ubuntu
  Linux 64-bit with the existing native loopback backends and separate
  microphone stream. Other Linux distributions remain unverified.
- The first desktop-only version uses explicit Start and Stop controls and a
  user-entered title. It does not depend on browser page injection, browser
  tab permissions, meeting detection, participant scraping, or a bot.
- Report capability and permission gaps honestly. Keep current documented
  fallback routing for devices where native loopback is unavailable.
- Recording state and consent guidance remain visible for the full capture.

## Extension transition and data safety

- New extension calls record Google Meet audio locally and stop at a durable
  saved-audio state. They do not require browser provider keys, upload audio to
  managed hosting, or start desktop calls. The desktop app remains the primary
  capture and processing product.
- Keep the Native Messaging host and current extension path working until the
  desktop app replaces their user-visible workflows and existing browser
  data has a tested migration/export path.
- Preserve extension IndexedDB meetings, provider settings, pending sync, and
  in-flight recordings. Never remove extension data or unregister its host as
  part of the initial desktop-app rollout.
- Provide a streamed `.ntarchive` export/import for legacy users. It carries
  meeting text, portable settings, and any raw Meet PCM still retained in
  IndexedDB as separate microphone and speaker channels. Keep the source
  extension unchanged. The existing extension deletes raw audio after a
  completed meeting is durable, so those completed recordings migrate as text.
- Accept older notes-only JSON transfers. Never put provider API keys, web-app
  tokens, or Google credentials in either archive format.
- Do not delete old hosted-service endpoints, authentication paths, or
  workspace records in this client migration. Deprecation is a later,
  separately verified contract step.

## Web-app boundary

- Local BYOK works with no web-app URL, API token, or account.
- Web-app sync is configured explicitly with a normalized base URL and
  authenticated API token. Keep the token in the OS credential vault.
- Sync only finalized note data by default: title, timestamps, transcript,
  summary, and action items. Do not sync raw audio, provider keys, or local
  paths.
- Create a revocable `desktop_notes_sync` token in web-app Settings →
  Integrations. Bind it to the active workspace and recheck membership on
  each request. Store the token in the OS credential vault. The dedicated
  `/api/v1/desktop-sync` route works on managed and self-hosted hosting; keep
  legacy `/api/meetings` and its `AUTH_TOKEN` contract unchanged.
- Persist outbox meeting IDs locally, then read finalized note text from the
  local store when retrying. Transcript timestamps may be absent; preserve
  segment order and leave timestamps null rather than fabricate timing.
- Clearly show connection status, last successful sync, and retryable failure
  without presenting a local recording as lost.
- Managed hosted processing and its account login are not required for this
  desktop-first local BYOK path. Existing managed web-app features remain
  separate until a future explicit product decision.

## Acceptance gates

- A fresh user can install one app, enter/test keys, grant audio access, record
  a real call, stop, and open the finished local note without installing an
  extension or signing into AI Notetaker.
- Recording survives provider outage and app restart; raw audio remains
  recoverable.
- Audio channels stay separate and the recording indicator stays visible.
- Optional web-app sync works with the configured API and token, retries
  idempotently, and does not block local completion.
- macOS, Windows, and Linux runtime acceptance is reported separately from
  compilation and automated checks.
- Existing extension users retain an explicit path to their meetings and
  settings until migration or export is proven.
