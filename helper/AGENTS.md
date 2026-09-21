# helper/ — Codex guidance

Read [`../CLAUDE.md`](CLAUDE.md) and [`../AGENTS.md`](../AGENTS.md) before
changing helper code. This package is Tauri/Rust, not Electron.

- Keep the persistent `notetaker-helper` Tauri app separate from the
  per-connection `notetaker-nm-host` relay. The relay stays Tauri-free and
  must not own pipeline state.
- Keep IPC on Native Messaging plus the local Unix socket/named pipe. Never
  introduce a TCP or loopback listener.
- Capture mic and speaker as separate streams, and write raw PCM to disk
  before any transcription request. Preserve retry and startup recovery.
- Wrap existing BlackHole, base VB-CABLE, or PulseAudio/PipeWire devices;
  never add a custom virtual audio driver. Do not bundle BlackHole's official
  binary. Any base VB-CABLE installer must retain vb-cable.com attribution and
  its donation option.
- Keep platform-specific packaging honest: signing/notarization and updater
  keys are user-owned release prerequisites, not fake local proof.
- When changing the wire format, update `docs/native-messaging-protocol.md`
  and tests together. Length prefixes are documented little-endian.

Run from `helper/`:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
