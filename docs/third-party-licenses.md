# Third-party license inventory

AI Notetaker is MIT-licensed. This inventory records the direct project
dependencies and separately calls out the external audio packages that the
installer wraps or links. A release owner must refresh a generated dependency
license report from the exact lockfiles before publishing an artifact.

## Direct runtime dependencies

- Rust: Tauri, cpal, reqwest, Tokio, Serde, UUID, Chrono, tracing, anyhow,
  thiserror, async-trait, bytes, rand, dirs, interprocess, and the Tauri
  autostart/updater plugins. Exact versions are pinned by `helper/Cargo.lock`.
- Webapp: Next.js, React, React DOM, Prisma, and `@prisma/client`, pinned by
  `webapp/package-lock.json`.
- Extension: TypeScript, esbuild, Vitest, and jsdom tooling, pinned by
  `extension/package-lock.json`.

## Audio dependencies and attribution

- macOS uses the official Existential Audio BlackHole distribution link; its
  compiled installer is not bundled by this project.
- Windows may stage the base VB-CABLE package only in a release workflow,
  with a pinned checksum, visible vendor installer, `vb-audio.com`
  attribution, and the donation option preserved.
- Linux wraps the user's PulseAudio/PipeWire null-sink facilities and does not
  ship a custom virtual-audio driver.

Before release, run a license scanner against the lockfiles, verify the
license texts required by every bundled dependency, and re-check the current
BlackHole/VB-CABLE redistribution terms.
