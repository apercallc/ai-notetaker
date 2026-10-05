# AI Notetaker — Desktop App

Tauri/Rust desktop app for setup, recording controls, local notes, recovery,
and optional authenticated web-app sync. It imports Chrome extension meeting
archives for transcription and can capture browser or desktop calls directly.
Workspace sync sends finished desktop note text to the web app; it is not a
round-trip sync. It works locally with provider API keys and no AI Notetaker
account. See the
architecture spec at
`../docs/superpowers/specs/2026-10-03-desktop-first-product-design.md` and
`CLAUDE.md` in this directory for the design this implements.

For a first-time user, use the [complete getting-started guide](../docs/getting-started.md).
This file explains the desktop workspace and contributor verification. The
Native Messaging host remains only for existing extension users during
migration; the desktop app communicates with its own UI through Tauri IPC.

The v0.18.2 [preview installers](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.2)
are published for macOS, Windows, and Debian/Ubuntu Linux. They are unsigned,
and fresh-install and real-call capture acceptance remains incomplete across
platforms. Check the [release acceptance checklist](../docs/launch/release-candidate-checklist.md)
before relying on a platform capture path. Native installers are the supported
distribution channel; npm/npx is not an end-user install method.

## Workspace layout

```
crates/
  core/    notetaker-core   — platform-agnostic: wire protocol, providers,
                               storage, retry queue, pipeline orchestration
  audio/   notetaker-audio  — AudioCapture trait + per-OS virtual-device
                               backends (macOS/ScreenCaptureKit + BlackHole,
                               Windows/WASAPI + VB-CABLE,
                               Linux/PulseAudio)
  app/     notetaker-app    — primary Tauri desktop window and persistent
                               background/tray runtime; also builds
                               notetaker-nm-host as a legacy extension relay
native-messaging-host-manifest/  — the Chrome host manifest template
```

The desktop Library organizes recordings in nested local folders. Moving a
note or folder updates `desktop-library.json` in the app data directory; it
does not move the saved mic/speaker audio used for recovery. Deleting an empty
folder never deletes recordings. Optional web-app sync currently sends finished
note text, without the desktop folder organization. Settings groups provider
keys, note preferences, web-app sync, and import controls.

## Building and testing

```sh
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets
```

Verified on 2026-10-05: **272 workspace tests pass**, `cargo fmt` and Clippy
pass, and all 9 macOS installer regression tests pass. The rebuilt debug Tauri
development app was opened on this Mac on 2026-10-03. This Mac's Command Line
Tools do not provide the default `XcodeDefault.xctoolchain` Swift library path.
The build succeeds with command-local `SDKROOT=.../MacOSX26.5.sdk`,
`MACOSX_DEPLOYMENT_TARGET=13.0`, and `RUSTFLAGS='-L .../usr/lib/swift/macosx'`;
no system developer-directory setting was changed. The previously built DMG
has now been rebuilt from the current source, checksum-verified, and opened
directly from its mounted image. Its app is ad-hoc signed, not Developer ID
signed or notarized. Real-call recording and Windows/Linux runtime acceptance
still need native device checks.

## What's genuinely verified vs. what isn't (read this before trusting a "done" claim)

**Fully implemented and tested** (mocked HTTP via `wiremock`, real
filesystem I/O via `tempfile`, no live credentials or hardware needed):

- Native Messaging wire framing (`core::native_messaging`) — round-trips
  every message type, rejects oversized frames, handles EOF distinctly.
- All 5 provider clients (Deepgram, Groq, Claude, Gemini, DeepSeek) —
  request shape, auth headers, success parsing, 401/403/429 error mapping.
- Local storage (`core::storage`) — meeting lifecycle, dual-channel audio
  file separation, bounded range reads for resumable managed uploads,
  transcript accumulation, crash-recovery scan.
- Retry queue (`core::resilience`) — exponential backoff math, persistence
  across reloads, durable PCM-range replay, and exhaustion handling.
- Pipeline orchestration (`core::pipeline`) — audio-persisted-before-
  transcription ordering, failure → retry-queue path, recoverable-meeting
  detection, using fake in-memory providers (the real providers are tested
  separately, above).
- Device-name matching (`audio::device_matching`) — pure string matching
  logic for finding BlackHole/VB-CABLE/the Linux null-sink among enumerated
  device names.

**Legacy Linux audio runtime verified on a real PipeWire desktop** — this
exercises the shared capture backend through the old helper path, not the full
desktop-first window journey. The module uses
`pactl` for virtual-source setup/probing, `parec` for the speaker monitor, and
cpal's default input device for the microphone. A live Native Messaging audio
probe and a short raw-audio recording have both been exercised.

- `audio::linux::LinuxAudioCapture` — real `cpal` mic capture plus `pactl`
  module setup/source probing and `parec` monitor capture; `parec` is
  provided by the distro's `pulseaudio-utils` package.
- `app` crate's IPC bridge (`ipc.rs`) and message dispatch (`main.rs`) —
  type-checks and unit-testable pieces are covered by `core`'s tests, but
  the two binaries talking to each other over a real socket, and to a real
  `notetaker-nm-host` process Chrome actually spawns, has not been
  exercised end-to-end.

**Compiled by native CI runners but not runtime-verified** — this Linux
environment has no macOS/Windows SDK toolchain, device, driver, UAC, or
meeting app. The GitHub Actions matrix is the native compile gate:

- `audio::macos` (ScreenCaptureKit system audio + BlackHole fallback) —
  compiled by the macOS CI runner; permission prompts, native stream startup,
  and fallback routing still need a real Mac.
- `audio::windows` (WASAPI loopback + VB-CABLE fallback) — compiled by the
  Windows CI runner; installer/UAC/reboot and device behavior still need a
  real Windows PC.

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
- **The macOS fallback Multi-Output Device / Windows "Listen to this device"
  setup** that lets the user keep hearing the meeting normally while a
  virtual fallback captures it still needs real-device validation. Native
  ScreenCaptureKit/WASAPI paths do not require those routing changes. Linux's
  `pactl module-loopback` equivalent *is* implemented.
- **Tray icon UI** — secondary to the primary Tauri app window. The tray offers
  idle/recording status, recent note/folder opening, opt-in launch-at-login,
  and quit; recording controls use Tauri IPC. The persistent runtime starts
  from `.setup()` and does not depend on a browser connection.
- **Crash-recovery transcription tail** — implemented. Recovery resumes each
  channel from its persisted transcribed-byte cursor, reads the remaining raw
  PCM in bounded batches, queues provider failures durably, and summarizes only
  after pending transcription retries finish. If reading saved audio fails,
  the meeting remains recoverable. Core tests cover tail transcription and
  completion; provider access and audio capture still need live-device proof.
- **Daily release checks** — the helper asks before opening the official
  GitHub download page and never installs silently. See
  `../docs/getting-started.md`.
- **Per-OS installer registration and trust prompts** — Debian and Windows
  installer hooks register Native Messaging, and macOS bundles guarded
  install/uninstall helpers. macOS first-open guidance and native installer
  execution still need checks on actual target hardware.

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
