# Meeting Workflows Implementation Plan

> Status: implemented locally and reflected in `TODO.md` as of September 21,
> 2026. The remaining unchecked roadmap items below are historical task
> checkboxes; owner-gated OS/audio/provider/deployment validation remains
> intentionally tracked in `TODO.md` rather than represented as completed by
> source changes alone.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Notetaker reliable to set up, useful after the meeting, and more accurate for different meeting types while preserving its local-first BYOK architecture.

**Architecture:** Add an audio diagnostics/probe contract to the existing Rust helper and Native Messaging protocol; the extension renders the preflight flow and persists only user settings/meeting metadata locally. Extend the existing meeting payload with stable action-item metadata and a meeting mode, then implement the same authenticated data in the optional webapp. Add bounded meeting-mode, vocabulary, and custom-instruction settings to the helper-owned summarization pipeline.

**Tech Stack:** Rust/Tauri, `cpal`, Tokio, serde, Chrome Manifest V3/TypeScript, `chrome.storage.local`, Next.js App Router, Prisma/Postgres, Vitest, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md` plus the root and package `CLAUDE.md`/`AGENTS.md` files.

## Global Constraints

- Keep all provider calls and summarization orchestration in `helper/`; the extension remains a UI/control layer.
- Use Native Messaging plus the existing local Unix/named-pipe relay; never add TCP, localhost WebSocket, or a project-operated backend.
- Preserve separate mic/speaker capture and raw-audio-before-provider persistence.
- Keep provider keys and local meeting records in `chrome.storage.local`; do not alter the committed manifest `key`.
- Keep the Tauri helper and both `notetaker-helper` and `notetaker-nm-host` binaries.
- Do not bundle BlackHole; preserve VB-CABLE attribution/donation copy.
- Keep every webapp route authenticated except `/api/health`, and keep Railway deployment free of new required environment variables.
- Preserve backward compatibility for existing extension settings, meetings, wire messages, and webapp rows by defaulting missing fields.

### Task 1: Audio preflight and guided setup

**Files:**
- Modify: `helper/crates/audio/src/lib.rs`, `helper/crates/audio/src/linux.rs`, `helper/crates/audio/src/macos.rs`, `helper/crates/audio/src/windows.rs`
- Modify: `helper/crates/app/src/main.rs`, `helper/crates/core/src/native_messaging.rs`
- Modify: `extension/src/types.ts`, `extension/src/lib/internalMessages.ts`, `extension/src/lib/nativeMessaging.ts`, `extension/src/lib/backgroundController.ts`, `extension/src/background.ts`
- Modify: `extension/src/onboarding/onboarding.ts`, `extension/src/onboarding/onboarding.css`, `extension/src/popup/popup.ts`, `extension/src/popup/popup.css`
- Modify: `docs/native-messaging-protocol.md`, `docs/helper-packaging.md`
- Test: audio unit tests, `helper/crates/core/src/native_messaging.rs` tests, `extension/tests/nativeMessaging.test.ts`, `extension/tests/backgroundController.test.ts`

**Interfaces:**
- `AudioCapture::diagnostics() -> AudioDiagnostics` reports driver, microphone, speaker, platform, and actionable guidance without sending audio anywhere.
- `AudioCapture::prepare() -> Result<(), AudioError>` is a no-op by default and lets Linux create its existing null-sink/remap devices before diagnostics; macOS/Windows keep their documented installer/manual routing boundaries.
- `AudioCapture::probe() -> Future<Result<AudioProbe, AudioError>>` briefly exercises both capture streams and reports per-channel frame counts; it never invokes a provider.
- Wire requests are `audio_preflight` and `audio_probe`; responses are `audio_status` and `audio_probe_result`.
- UI requests are `GET_AUDIO_PREFLIGHT` and `RUN_AUDIO_PROBE`, resolved by the background controller through Native Messaging.

- [ ] Add pure `AudioDiagnostics`/`AudioProbe` structs and a default probe implementation that starts capture, samples for a bounded interval, stops capture, and reports mic/speaker frame counts.
- [ ] Implement platform diagnostics using the existing driver matching and default-input enumeration; keep BlackHole linking and VB-CABLE attribution unchanged.
- [ ] Store one audio backend in `AppState`, handle preflight/probe messages, and reuse that backend for recording.
- [ ] Extend the protocol docs and serde/TypeScript message unions with compatibility-safe fields.
- [ ] Add one-click “Check audio” and “Run 2-second test” states to onboarding, with missing-device guidance and disabled recording until the preflight is ready.
- [ ] Add a compact “Audio ready / Fix setup” status to the popup idle view.
- [ ] Run focused Rust and extension tests before moving on.

### Task 2: Action-item inbox and durable tracking

**Files:**
- Modify: `helper/crates/core/src/native_messaging.rs`, `helper/crates/core/src/providers/mod.rs` only as needed for wire-compatible action-item fields
- Modify: `extension/src/types.ts`, `extension/src/lib/storage.ts`, `extension/src/lib/backgroundController.ts`, `extension/src/lib/webappSync.ts`, `extension/src/meeting/meeting.ts`, `extension/src/meeting/meeting.css`, `extension/src/popup/popup.ts`, `extension/src/popup/popup.css`
- Create: `extension/src/actions/actions.html`, `extension/src/actions/actions.ts`, `extension/src/actions/actions.css`
- Modify: `extension/manifest.json` only if the new packaged page requires an explicit entry; preserve the existing `key`
- Modify: `webapp/prisma/schema.prisma`, create a Prisma migration under `webapp/prisma/migrations/`
- Modify: `webapp/src/lib/types.ts`, `webapp/src/lib/meetings.ts`, `webapp/src/app/meetings/[id]/page.tsx`, `webapp/src/app/meetings/page.tsx`, `webapp/src/app/meetings/[id]/actions.ts`
- Create: `webapp/src/app/actions/page.tsx`, `webapp/src/app/actions/ActionItemRow.tsx`, `webapp/src/app/actions/actions.ts`
- Test: extension storage/controller tests; webapp meetings/API tests and action-inbox tests

**Interfaces:**
- `ActionItem` has stable `id`, `text`, optional `owner`, `status: "open" | "done"`, optional `dueAt`, and optional `completedAt`.
- Incoming helper action items remain backward-compatible; the extension assigns stable IDs and preserves existing status/due metadata when a late retry replaces a summary.
- The webapp meeting POST accepts optional action-item IDs/status/dates, defaults missing data, and remains idempotent.
- The webapp exposes an authenticated `/actions` page and server action for status/due-date updates; no new public API or account system is added.

- [ ] Add stable local action-item hydration/merge logic and a reusable authenticated webapp-sync function.
- [ ] Add local action-item update persistence, a popup link, and a dedicated extension action inbox with open/done filtering, due-date editing, and meeting links.
- [ ] Add Prisma fields/indexes, migration, validation, serialization, and authenticated webapp update functions.
- [ ] Add webapp action inbox navigation, empty/loading/error-safe states, accessible checkbox/date controls, and meeting-detail action controls.
- [ ] Add Markdown export metadata for status/due dates and preserve the existing delete confirmation.
- [ ] Run focused client/webapp tests and verify `git diff --check`.

### Task 3: Meeting modes, vocabulary, and summary templates

**Files:**
- Modify: `helper/crates/core/src/native_messaging.rs`, `helper/crates/core/src/providers/mod.rs`, all three summarization provider files, `helper/crates/core/src/pipeline.rs`
- Modify: `helper/crates/app/src/main.rs`
- Modify: `extension/src/types.ts`, `extension/src/lib/nativeMessaging.ts`, `extension/src/lib/backgroundController.ts`, `extension/src/popup/popup.ts`, `extension/src/popup/popup.css`, `extension/src/settings/settings.ts`, `extension/src/settings/settings.css`, `extension/src/onboarding/onboarding.ts`
- Modify: `webapp/prisma/schema.prisma`, create a migration if the meeting mode requires it
- Modify: `webapp/src/lib/types.ts`, `webapp/src/lib/meetings.ts`, `webapp/src/app/meetings/[id]/page.tsx`
- Test: provider prompt/parser tests, pipeline tests, extension settings/controller tests, webapp payload tests

**Interfaces:**
- `MeetingMode` is `general | standup | sales | one_on_one | interview | custom` across Rust, TypeScript, and webapp payloads.
- `NotetakerSettings` adds `defaultMeetingMode`, `customVocabulary`, and `customSummaryInstructions`, all defaulting safely for existing users.
- `start_recording` carries the selected mode; `settings` carries bounded vocabulary/instructions to the helper.
- `SummaryOptions` is passed into the helper summarization provider and produces a mode-specific prompt without moving provider calls out of Rust.

- [ ] Add the shared mode/options types, bounded normalization, protocol fields, and backward-compatible defaults.
- [ ] Update Claude, Gemini, and DeepSeek prompt construction to include the selected mode, vocabulary, and custom instructions while retaining strict JSON parsing.
- [ ] Preserve summary options through normal and retry/re-summary pipeline construction.
- [ ] Add settings controls for default mode, vocabulary, and custom instructions plus a per-recording mode selector in the popup.
- [ ] Persist and display the mode in local/webapp meeting records and exports.
- [ ] Add tests for prompt construction, defaults, bounds, wire serialization, and UI settings persistence.

### Task 4: Documentation, review, and release-floor verification

- [ ] Update `README.md`, `TODO.md`, `docs/webapp-api.md`, and relevant package READMEs with the implemented workflows and honest OS/provider verification boundaries.
- [ ] Run the design review against onboarding, popup, action inbox, meeting detail, and webapp states; fix concrete accessibility/dark-mode/reduced-motion findings.
- [ ] Run the guardrails review against the complete diff and fix every concrete finding.
- [ ] Run the required release-floor commands from the root guidance, separating local test/build proof from real OS/audio/provider/browser/deployment proof.
- [ ] Recheck status and report changed files, tests, build results, and remaining owner-gated validation. Do not commit or push unless separately requested.
