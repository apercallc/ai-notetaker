# helper/ — Codex guidance

Read [`../CLAUDE.md`](CLAUDE.md) and [`../AGENTS.md`](../AGENTS.md) before
changing helper code. This package is Tauri/Rust, not Electron.

- The `notetaker-helper` Tauri app is the primary product and owns its UI,
  capture, and pipeline. Keep `notetaker-nm-host` only as a compatibility
  relay for legacy extensions until the migration plan's acceptance gates
  pass; the relay must not own pipeline state.
- Use Tauri IPC for desktop UI. Never introduce a TCP or loopback listener.
  Native Messaging plus the Unix socket/named pipe remains only for extension
  compatibility during migration.
- Capture mic and speaker as separate streams, and write raw PCM to disk
  before any transcription request. Preserve retry and startup recovery.
- Store provider keys in the platform OS credential vault. Never store them
  in ordinary settings JSON or send them to the web app.
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
