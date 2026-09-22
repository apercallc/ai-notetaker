# AI Notetaker — Desktop Helper

Tauri/Rust desktop capture helper. See the architecture spec at
`../docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md` and
`CLAUDE.md` in this directory for the design this implements.

For a first-time user, use the [complete getting-started guide](../docs/getting-started.md).
This file explains the helper workspace and contributor verification. In
particular, `cargo build` creates binaries but does not register Chrome's
Native Messaging host; use the packaged installer flow in
[`../docs/helper-packaging.md`](../docs/helper-packaging.md) when you need a
working extension-to-helper install.

## Workspace layout

```
crates/
  core/    notetaker-core   — platform-agnostic: wire protocol, providers,
                               storage, retry queue, pipeline orchestration
  audio/   notetaker-audio  — AudioCapture trait + per-OS virtual-device
                               backends (macOS/BlackHole, Windows/VB-CABLE,
                               Linux/PulseAudio)
  app/     notetaker-app    — two binaries: notetaker-helper (the
                               persistent tray app) and notetaker-nm-host
                               (the Native Messaging host Chrome spawns)
native-messaging-host-manifest/  — the Chrome host manifest template
```

## Building and testing

```sh
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets
```

As of this implementation pass: **96 Rust tests passing (89 in `core`, 6 in
`audio`, and 1 fixture integration test), zero compiler warnings, zero clippy
warnings**. Linux is verified locally; the helper CI matrix also compiles and
tests the platform-gated macOS and Windows modules on their native runners.

## What's genuinely verified vs. what isn't (read this before trusting a "done" claim)

**Fully implemented and tested** (mocked HTTP via `wiremock`, real
filesystem I/O via `tempfile`, no live credentials or hardware needed):

- Native Messaging wire framing (`core::native_messaging`) — round-trips
  every message type, rejects oversized frames, handles EOF distinctly.
- All 5 provider clients (Deepgram, Groq, Claude, Gemini, DeepSeek) —
  request shape, auth headers, success parsing, 401/403/429 error mapping.
- Local storage (`core::storage`) — meeting lifecycle, dual-channel audio
  file separation, transcript accumulation, crash-recovery scan.
- Retry queue (`core::resilience`) — exponential backoff math, persistence
  across reloads, durable PCM-range replay, and exhaustion handling.
- Pipeline orchestration (`core::pipeline`) — audio-persisted-before-
  transcription ordering, failure → retry-queue path, recoverable-meeting
  detection, using fake in-memory providers (the real providers are tested
  separately, above).
- Device-name matching (`audio::device_matching`) — pure string matching
  logic for finding BlackHole/VB-CABLE/the Linux null-sink among enumerated
  device names.

**Compiles cleanly (Linux target) but not runtime-verified** — no audio
hardware, no display, no live meeting in this environment:

- `audio::linux::LinuxAudioCapture` — real `cpal` + `pactl` module setup
  code; `pactl` calls will genuinely run if PulseAudio/PipeWire is present,
  but nothing here exercised an actual meeting's audio.
- `app` crate's IPC bridge (`ipc.rs`) and message dispatch (`main.rs`) —
  type-checks and unit-testable pieces are covered by `core`'s tests, but
  the two binaries talking to each other over a real socket, and to a real
  `notetaker-nm-host` process Chrome actually spawns, has not been
  exercised end-to-end.

**Compiled by native CI runners but not runtime-verified** — this environment
has no macOS/Windows device, driver, UAC, or meeting app:

- `audio::macos` (BlackHole detection + capture) — compiled by the macOS job;
  install and Multi-Output Device behavior still need a real Mac.
- `audio::windows` (VB-CABLE detection + capture) — compiled by the Windows
  job; installer/UAC/reboot and device behavior still need a real Windows PC.

**Explicitly not implemented, flagged rather than faked:**

- **Deepgram is wired to the batch REST endpoint, not the live-streaming
  WebSocket endpoint** the spec names as the default — see the scope note
  at the top of `crates/core/src/providers/mod.rs`. Same `TranscriptionProvider`
  trait either way; swapping later touches only `deepgram.rs`.
- Batch providers receive roughly five seconds of audio per request. Capture
  frames are written locally as they arrive, then coalesced to avoid turning
  every sound-card callback into a provider request; the final partial batch
  is flushed before summarization. This keeps the batch-tier latency/cost
  trade-off explicit.
- **Windows VB-CABLE execution** — release-only checksum-pinned staging and
  the visible vendor installer launch are wired in
  `audio::windows::install_if_missing`; this sandbox has no Windows target,
  UAC environment, or audio device to verify the native flow against.
- **The macOS Multi-Output Device / Windows "Listen to this device" setup**
  that lets the user keep hearing the meeting normally while we capture it
  — needs platform APIs below what `cpal` exposes (CoreAudio aggregate
  devices on macOS, WASAPI endpoint control on Windows). Documented as a
  known gap in both `audio::macos` and `audio::windows` module docs.
  Linux's `pactl module-loopback` equivalent *is* implemented.
- **Tray icon UI** — wired through Tauri v2 with idle/recording status, recent
  note/folder opening, opt-in launch-at-login, and quit. The helper has no
  main window; Tauri owns the process main thread and the IPC server starts
  from `.setup()`.
- **Re-transcribing the raw-audio tail after crash recovery** — pending retry
  queue files are reloaded after the next authenticated settings handshake,
  but `resume_recording` still finalizes whatever transcript existed before
  the crash rather than reconstructing a final chunk that was captured but
  never reached the transcription provider. The raw audio itself is never
  lost (that's the resilience guarantee, and it holds).
- **Tauri auto-updater configuration** — plugin and artifact shape are wired,
  but updater keys/endpoints are owner-generated release placeholders. See
  `../docs/helper-packaging.md`.
- **Per-OS installer registration and code signing** — Debian and Windows
  package hooks register Native Messaging, and macOS bundles guarded
  install/uninstall helpers; macOS notarization, Windows signing, and the
  macOS post-copy helper run still require native release work.

## A deviation from the docs, flagged as instructed

`docs/native-messaging-protocol.md` specifies the extension↔helper wire
format but doesn't address a real process-lifecycle mismatch: Chrome spawns
a fresh native-messaging-host process per `connectNative()` call and kills
it on disconnect, but the architecture wants the helper to be a **persistent**
background app (so crash recovery and always-ready capture work). Resolved
by splitting into two binaries — `notetaker-nm-host` (what Chrome actually
spawns, a thin stdio↔local-socket relay) and `notetaker-helper` (the real
persistent process, listening on that local socket) — documented in
`crates/app/src/ipc.rs`. This should get folded back into the protocol doc
by whoever owns it next.
