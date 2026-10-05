# Desktop-First Product Migration Plan

Status: Active
Target architecture: `docs/superpowers/specs/2026-10-03-desktop-first-product-design.md`

## Task 1 — Make the desktop app the control surface

- [x] Add a real Tauri main window with setup, audio readiness, recording
      controls, and local meeting history. Development window visually inspected
      on macOS; no release package yet.
- [x] Expose Tauri commands over the existing capture and processing pipeline;
      keep UI control inside Tauri IPC, with no local network port.
- [x] Keep the tray as secondary status and quick actions.
- [x] Add an explicit desktop action to recover crash-interrupted local audio;
      preserve the existing pipeline and reject duplicate recovery requests.
- [ ] Complete explicit recording, processing, recovered, empty, offline, and
      permission-denied states and verify their runtime transitions. The
      Record page now surfaces saved-audio recovery and processing, distinguishes
      permission-related audio setup, and preserves drafts/search during refresh;
      native state transitions are still unverified.

## Task 2 — Move setup and BYOK settings into the app

- [x] Add provider/key selection and safe key testing.
- [x] Store provider API keys in OS credential storage; keep ordinary
      preferences in the app's private data folder.
- [x] Keep local BYOK account-free and preserve existing in-flight records.
- [x] Export/import portable provider preferences without exporting credentials;
      users re-enter provider keys in the desktop app. Web-app/Google tokens stay
      separate and existing extension credentials remain untouched.
- [x] Add a first-run capability check with platform-specific audio guidance.
- [x] Add a macOS Screen Recording settings shortcut when native system audio
      is unavailable; granting access remains a user action.

## Task 3 — Make local recording a complete workflow

- [x] Start and stop system-output plus microphone capture from the app.
- [x] Reuse separate mic and system audio persistence before provider requests.
- [x] Show title, transcript, summary, and action items in local history.
- [x] Preserve existing crash recovery, retry, deletion, and open-notes-folder
      behavior where the app surface exposes it.
- [x] Keep API/provider failures from hiding or deleting saved audio.

## Task 4 — Connect the optional web app

- [x] Let users save and open a configured web-app URL from the desktop app.
- [x] Add a revocable `desktop_notes_sync` API token bound to the active web-app
      workspace; recheck membership and token scope on every request.
- [x] Keep the sync token in OS credential storage; never send provider keys.
- [x] Add `/api/v1/desktop-sync` connection check and idempotent meeting upsert;
      sync finished transcript, summary, and action items only. Reject payloads
      labeled as Meet capture or managed processing at the desktop route.
- [x] Refresh local copies of workspace-owned notes when a newer web revision
      arrives. Bind each copy to its server URL and workspace ID; preserve
      desktop-origin notes with matching IDs.
- [x] Add an ID-only durable outbox, automatic retry, existing-note sync, and
      visible pending/last-success/error state.
- [x] Allow nullable transcript timestamps without inventing timing; preserve
      transcript order and support older consumers in export/Google/Notion.
- [ ] Verify a real workspace/token and restart recovery after network outage.

## Task 5 — Preserve and migrate extension data

- [x] Make new extension calls Google Meet audio recordings only. Save mic and
      speaker tracks in IndexedDB without browser provider calls; expose
      archive export and keep earlier notes/settings available.
- [ ] Verify a real saved Meet recording exports and imports to the desktop
      app, then produces notes using desktop BYOK processing.

- [ ] Inventory real extension IndexedDB audio, pending sync, and in-flight
      recordings before retiring the legacy data path.
- [x] Provide an explicit JSON transfer for note text and portable preferences,
      capped at 20 MB. It preserves partial transcript text and source state.
      Keys/tokens, Google connections, and raw audio are excluded; the extension
      source stays intact.
- [x] Add a single-file `.ntarchive` export/import that streams retained Meet
      PCM from IndexedDB to disk and into separate local mic/speaker tracks.
      Per-chunk CRC, ordered sequences, sample rate, bounded reads, and an
      end-marker make interrupted or damaged files fail closed. Import is
      idempotent and never changes extension data. Successfully processed Meet
      audio was already deleted by the extension, so those meetings migrate as
      text only.
- [ ] Keep old extension installations and Native Messaging registration
      compatible throughout the migration window.
- [x] Prove imported notes open with transcript timestamps, summary, and action
      item state. Re-import skips matching ids and never removes source data.
- [x] Add a desktop action that creates a separate local note from imported
      extension PCM, then reuses the existing BYOK recovery pipeline. It keeps
      the source transcript, summary, and audio unchanged and reuses one copy
      on repeat requests.
- [ ] Verify live archive import and BYOK reprocessing with working system
      audio. Mac permission/audio setup and a test archive are still missing.
- [ ] Verify a real Chrome export/import with a large archive and confirm the
      exact audio tracks in the desktop library. The shared fixture in
      `extension/test-fixtures/` is emitted byte-for-byte by the extension
      exporter test and imported by the Rust test; live browser-to-app transfer
      remains unverified.

## Task 6 — Retire the extension only after acceptance

- [ ] Validate one-install onboarding and real recording on macOS, Windows,
      and Linux.
- [ ] Verify web-app sync, provider outage recovery, and restart recovery.
- [x] Make the download page expose published desktop installers and explain
      first-run setup without sending new users to extension setup.
- [x] Update installer, download page, README, support/privacy guidance, and
      release packaging to describe the one-app setup. Build and verify guided
      arm64 and x86_64 Mac DMGs locally; no public release or Intel-device
      acceptance is claimed.
- [ ] Only then remove Native Messaging installer hooks, relay binary, and
      extension-specific runtime code. Keep extension archive/export available
      for existing users during the announced compatibility window.

## Rollback

- Keep the extension package, IndexedDB records, Native Messaging relay, and
  current hosted routes intact until Tasks 1–5 pass their acceptance gates.
- If a desktop release regresses capture or local processing, users can return
  to the previous extension/helper release; no database or local recording
  format is destructively migrated by this plan.
