# helper/ — Desktop Capture Helper

Tauri (Rust), not Electron — smaller install and one shared codebase across
macOS/Windows/Linux with small platform-specific audio modules. Daily stable
release checks ask before opening the GitHub download page; installers are
downloaded and run by the user. See
`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md` (§3.1)
for the full rationale.

## Conventions

- **This package is the primary desktop app.** Its Tauri window owns setup,
  long-running capture, local durability, local BYOK provider calls, local
  notes, recovery, and optional authenticated web-app sync. The tray is a
  secondary status and quick-action surface; Native Messaging stays only for
  installed legacy extensions during migration.
- **Prefer native loopback capture — don't build a driver.** Use
  ScreenCaptureKit/native audio on macOS, WASAPI loopback on Windows, and
  PipeWire/PulseAudio monitor sources on Linux. BlackHole, VB-CABLE, and a
  null-sink module remain explicit fallbacks for unsupported routing cases.
- **BlackHole and VB-Cable have different, verified redistribution terms —
  don't treat them the same.** macOS: never bundle Existential Audio's
  compiled BlackHole installer (GPL source, but the official binary and
  branding are separately all-rights-reserved) — detect-if-missing and
  deep-link to their official download instead. Windows: only the base
  VB-CABLE package may be bundled; stage the complete official archive with a
  release-time checksum, launch its visible administrator installer, and keep
  vb-cable.com attribution and the donation option visible in the installer
  UI. Never bundle A+B/C+D variants or fetch a driver at runtime.
- **Capture mic and speaker as separate channels/streams, always.** Never
  merge them into one blob before sending to the transcription API — the
  dual-channel split is what gives "you vs. everyone else" diarization for
  free.
- **Raw audio to local disk before any API call, every time.** No code path
  should send captured audio to a transcription provider without having
  already persisted it locally first. This is the resilience guarantee: a
  failed API call must never mean lost audio.
- **New providers implement the shared provider interface.** See the
  `notetaker-add-provider` skill before adding a transcription or LLM
  provider — it walks through preserving the resilience guarantee, honest
  streaming-vs-batch labeling, and cost documentation.
- **Tauri IPC, not an open port**, for desktop UI-to-Rust control. Keep Native
  Messaging only for backward compatibility with already-installed
  extensions; do not require it for a new desktop installation.
- **Store provider keys in OS credential storage.** Never place provider keys
  in ordinary settings JSON or send them to the web app.
- **Detect and offer to resume an in-progress recording on startup.**
  Because raw audio is written incrementally during capture, an unclean
  shutdown (crash, forced quit, OS restart) leaves recoverable audio behind
  — check for it on launch rather than leaving it orphaned.
