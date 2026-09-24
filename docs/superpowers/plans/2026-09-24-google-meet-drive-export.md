# Google Meet Browser Capture and Google Drive Export Implementation Plan

> **Historical plan notice:** The “no hosted backend, subscription, or
> billing” constraint below was superseded on 2026-09-24. Use
> [`2026-09-24-scribbl-dual-mode-product-migration.md`](2026-09-24-scribbl-dual-mode-product-migration.md)
> for current work. The Meet and Drive details remain useful as implementation
> history and compatibility requirements.

> **Capture ownership amendment:** The current dual-mode implementation makes
> the Chrome extension the source of truth for Meet chunks in IndexedDB. The
> helper is optional for Meet and remains required for desktop-call sources.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable, low-setup Google Meet browser capture mode and an optional local-first Google Drive meeting-notes export. Meet may finish through the extension's local BYOK or Hosted AI path; the helper remains the desktop-call pipeline owner.

**Architecture:** The Meet offscreen document captures the active Meet tab's remote audio and the user's microphone, then streams bounded PCM16 chunks over the existing authenticated Native Messaging port. The Rust helper starts the existing `Pipeline` in external-capture mode and persists each independent channel before any provider call. Drive export is a separate least-privilege OAuth integration in the extension, with a pure formatter and best-effort export state attached to the local meeting.

**Tech Stack:** TypeScript, Manifest V3 service worker/offscreen document, Chrome `tabCapture` and `offscreen` APIs, Native Messaging JSON framing, Rust/Tokio/Tauri, existing `notetaker_core::Pipeline`, Google OAuth/Drive v3/Docs v1 REST APIs, Vitest, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-24-google-meet-drive-export-design.md`

## Global Constraints

- The original no-backend/subscription constraint is historical; the current
  product also supports optional authenticated Hosted AI with billing and
  usage enforcement.
- The helper owns desktop capture state, raw persistence, provider calls,
  retries, and crash recovery; the extension owns Meet capture, local chunk
  persistence, and direct BYOK or managed processing for Meet.
- Extension↔helper communication uses Native Messaging plus the local Unix/named-pipe relay; never TCP or an open localhost port.
- Mic and speaker are independent channels and raw PCM is persisted before provider calls.
- Local API keys and OAuth tokens live only in `chrome.storage.local`; managed
  provider secrets remain server-side.
- Keep `extension/manifest.json`'s committed `key` unchanged and keep both helper binaries.
- Meet is the first-run browser capture path; Slack Huddles, Zoom, and Teams
  remain helper capture.
- Existing Calendar OAuth is not treated as Drive authorization; Drive uses its own connection and `https://www.googleapis.com/auth/drive.file`.
- Every changed surface gets focused tests, then the required extension/helper release-floor checks.

## Review Focus

- Active-tab capture denied or the user navigates away: show a recoverable state and release tracks without losing local audio.
- One browser channel starts later or stops early: preserve the other channel and keep raw files separate.
- Native Messaging chunk too large, invalid base64, wrong meeting id, or wrong sample rate: reject it safely and report a useful recording error.
- OAuth cancellation, expired access token, duplicate folder names, and Drive outage: local meeting remains complete and export is retryable.
- Old settings and old helper versions: default missing fields safely and retain the existing desktop protocol.

### Task 1: Lock the shared types and note formatter

**Files:**
- Create: `extension/src/lib/meetingNotes.ts`
- Create: `extension/tests/meetingNotes.test.ts`
- Modify: `extension/src/types.ts`
- Modify: `extension/src/lib/storage.ts`

**Interfaces:**
- Produce `formatMeetingNotes(meeting: MeetingRecord): string`, `driveTitle(meeting): string`, and nullable `MeetingRecord.driveExport` state.
- Produce `CaptureSource = "desktop" | "meet"` and `DriveConnection` types used by later tasks.

- [ ] Write failing tests for stable section order, action-item checkboxes/owners/dates, transcript speaker labels, title sanitization, and backward-compatible settings defaults.
- [ ] Run `cd extension && npx vitest run tests/meetingNotes.test.ts`; confirm failure because the formatter/types do not exist.
- [ ] Implement the pure formatter and storage normalization with no network or DOM dependencies.
- [ ] Run the focused test, then `cd extension && npm test`; confirm all tests pass.
- [ ] Manually review that secrets remain local-only and that existing meetings deserialize without `driveExport`.

### Task 2: Add Drive OAuth and export service

**Files:**
- Create: `extension/src/lib/drive.ts`
- Create: `extension/tests/drive.test.ts`
- Modify: `extension/src/types.ts`
- Modify: `extension/src/lib/storage.ts`

**Interfaces:**
- Consume `DriveConnection`, `MeetingRecord`, and `formatMeetingNotes`.
- Produce `connectGoogleDrive(fetchImpl?)`, `disconnectGoogleDrive()`, `exportMeetingToDrive(meeting, connection, fetchImpl?)`, and `retryDriveExport(meetingId)`-ready result data.

- [ ] Write failing tests for the OAuth URL/state/redirect exchange, cancellation, folder lookup/create under Drive root, deterministic duplicate-folder selection, document creation, escaping, 401 refresh failure, and non-blocking export errors.
- [ ] Run the focused Drive tests and verify the missing-module failures.
- [ ] Implement OAuth using `chrome.identity.launchWebAuthFlow`, `drive.file`, `chrome.storage.local`, and direct Google REST calls; never send tokens to the helper or project services.
- [ ] Implement find-or-create of the exact root child folder named `ai-notetaker`, then create a Google Doc with the formatter output and meeting/date title.
- [ ] Run `cd extension && npx vitest run tests/meetingNotes.test.ts tests/drive.test.ts && npm test`; confirm green.

### Task 3: Wire Drive into completion and meeting UI

**Files:**
- Modify: `extension/src/lib/backgroundController.ts`
- Modify: `extension/src/lib/internalMessages.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/meeting/meeting.ts`
- Modify: `extension/src/meeting/meeting.html`
- Modify: `extension/src/meeting/meeting.css`
- Create or modify: `extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consume `exportMeetingToDrive` and the local meeting store.
- Produce `DRIVE_EXPORT`, `RETRY_DRIVE_EXPORT`, and `DISCONNECT_DRIVE` UI/background messages plus visible export status/link/error in the meeting view.

- [ ] Add failing controller/UI tests proving summary completion stays `complete` when Drive is unconnected or fails, while a connected Drive export is queued after the local save.
- [ ] Run the focused controller tests red.
- [ ] Implement best-effort completion export, durable export status, explicit retry, and safe rendering of Drive links/errors.
- [ ] Run the focused tests and the complete extension suite.

### Task 4: Add the helper external-capture protocol and pipeline path

**Files:**
- Modify: `helper/crates/core/src/native_messaging.rs`
- Modify: `helper/crates/core/src/pipeline.rs`
- Modify: `helper/crates/app/src/main.rs`
- Modify: `helper/crates/core/tests/full_pipeline.rs`
- Modify: `helper/crates/core/src/native_messaging.rs` tests
- Modify: `docs/native-messaging-protocol.md`

**Interfaces:**
- Extend `StartRecording` with `capture_source` defaulting to `desktop`.
- Add `ExtensionToHelper::AudioChunk { meeting_id, channel, sample_rate_hz, pcm16_base64 }` and `ExternalCaptureStopped` only if needed by the implementation; cap decoded chunks and enforce 48 kHz/PCM16 contract.
- Add `Pipeline::start_recording_external` or an equivalent explicit state transition that reuses `handle_audio_chunk` and `stop_recording` without starting the OS capture backend.

- [ ] Add failing Rust tests for serde round-trips, default desktop compatibility, valid independent chunks, invalid/oversized chunks, and raw-file persistence before provider calls.
- [ ] Run `cd helper && cargo test -p notetaker-core native_messaging full_pipeline`; confirm red.
- [ ] Implement bounded decoding/validation, per-meeting channel checks, external active-state tracking, and message dispatch in the persistent helper. Never let browser audio bypass `Pipeline`.
- [ ] Run `cd helper && cargo fmt --all -- --check && cargo test -p notetaker-core`; confirm green.
- [ ] Update the protocol examples and security notes with the chunk ceiling and browser-capture lifecycle.

### Task 5: Implement the Meet offscreen capture lifecycle

**Files:**
- Create: `extension/src/meet/meetCapture.ts`
- Create: `extension/src/meet/offscreen.ts`
- Create: `extension/src/meet/offscreen.html`
- Create: `extension/tests/meetCapture.test.ts`
- Modify: `extension/src/lib/nativeMessaging.ts`
- Modify: `extension/src/lib/internalMessages.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/manifest.json`

**Interfaces:**
- Consume `CaptureSource`, the Native Messaging external-capture methods, and background meeting lifecycle.
- Produce `MeetCaptureController.start(tabId, meetingId)`, `.stop(meetingId)`, `.status()`, and bounded mic/speaker chunk sends.

- [ ] Write failing tests for offscreen creation/reuse, start/stop message flow, one mic and one speaker chunk, cleanup on stream error, and rejection of unsupported/non-Meet tabs.
- [ ] Run the focused Meet tests red.
- [ ] Implement an offscreen document that calls `tabCapture.getMediaStreamId`, captures tab audio as speaker, captures microphone separately, converts to signed little-endian PCM16 at 48 kHz, batches under 64 KiB per Native Messaging message, and stops all tracks on teardown.
- [ ] Add explicit UI-visible status and fallback guidance: browser capture is for Google Meet; other apps use the helper; navigation/permission loss can be retried.
- [ ] Run focused tests, `npm run typecheck`, `npm test`, and `npm run build`.

### Task 6: Connect onboarding, popup, settings, and docs

**Files:**
- Modify: `extension/src/onboarding/onboarding.ts`
- Modify: `extension/src/onboarding/onboarding.css`
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/src/settings/settings.ts`
- Modify: `extension/src/settings/settings.html`
- Modify: `extension/src/settings/settings.css`
- Modify: `docs/getting-started.md`
- Modify: `docs/data-handling.md`
- Modify: `README.md`
- Modify: `docs/chrome-web-store-listing.md`

- [ ] Add failing UI/logic tests for mode selection copy, app-specific routing instructions, two-key explanation, Drive connect/disconnect state, and Meet permission/fallback messages.
- [ ] Run the focused extension tests red.
- [ ] Implement concise progressive disclosure: “Google Meet in this tab” starts browser capture; “Zoom/Teams/Slack Huddle” starts helper capture; output/mic device instructions remain explicit for helper mode.
- [ ] Document Google OAuth client setup, Drive scope, `My Drive/ai-notetaker`, note format, local-first guarantees, and that export is optional/retryable.
- [ ] Run all extension tests/build and `git diff --check`.

### Task 7: Full verification and guardrails review

**Files:**
- Modify: `TODO.md` with completed work and explicit live-proof deferments.

- [ ] Run `cd helper && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.
- [ ] Run `cd extension && npm run typecheck && npm test && npm run build`.
- [ ] Run `git diff --check` and inspect the complete diff against `CLAUDE.md`, `extension/CLAUDE.md`, `helper/AGENTS.md`, the design review, and the guardrails review.
- [ ] Perform a local Native Messaging handshake test and a mocked Drive export test; distinguish those from real Google OAuth/Meet capture proof.
- [ ] Do not claim SignPath, package installation, or real browser-provider proof unless it actually ran; leave the earlier dirty changes intact.
