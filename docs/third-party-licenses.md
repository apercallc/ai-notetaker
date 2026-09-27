# Third-party license inventory

AI Notetaker is MIT-licensed. This inventory records the direct project
dependencies and separately calls out the external audio packages that the
installer wraps or links. A release owner must still refresh a generated
dependency license report from the exact lockfiles immediately before
publishing an artifact — dependency sets and their licenses can change
between this check and a real release.

## Direct runtime dependencies

- Rust: Tauri (MIT OR Apache-2.0), cpal (Apache-2.0), reqwest (MIT OR
  Apache-2.0), Tokio (MIT), Serde (MIT OR Apache-2.0), UUID (MIT OR
  Apache-2.0), Chrono (MIT OR Apache-2.0), tracing (MIT), anyhow (MIT OR
  Apache-2.0), thiserror (MIT OR Apache-2.0), async-trait (MIT OR
  Apache-2.0), bytes (MIT), rand (MIT OR Apache-2.0), dirs (MIT OR
  Apache-2.0), interprocess (MIT OR Apache-2.0), and the Tauri
  autostart/updater plugins (MIT OR Apache-2.0). Exact versions are pinned by
  `helper/Cargo.lock`. All permissive, no copyleft, no source-disclosure
  obligation.
- Webapp: Next.js (MIT), React (MIT), React DOM (MIT), Prisma and
  `@prisma/client` (Apache-2.0), pinned by `webapp/package-lock.json`. All
  permissive.
- Extension: TypeScript, esbuild, Vitest, and jsdom tooling (all MIT),
  pinned by `extension/package-lock.json`; these are dev/build-time only —
  the shipped extension bundle has zero runtime npm dependencies.

None of the above are copyleft (GPL/AGPL/LGPL), so none impose a
source-disclosure or license-propagation obligation on this MIT project.

## AI transcription/summarization provider SDKs

**Checked 2026-09-23: no vendor SDK is used.** `helper/crates/core` calls
every provider (Deepgram, Groq, Claude, Gemini, DeepSeek) over plain HTTP/WS
via `reqwest`/`tokio-tungstenite` — there is no Deepgram/Anthropic/Google/
DeepSeek SDK crate or npm package anywhere in `helper/Cargo.toml`,
`helper/crates/*/Cargo.toml`, `extension/package.json`, or
`webapp/package.json`. This means there are no third-party SDK license terms
to track beyond the generic HTTP client crates already listed above; each
provider's terms of service (not a license) govern API usage and are the
user's own BYOK responsibility, documented in `README.md`'s cost table.

## Audio dependencies and attribution

- **BlackHole (macOS).** Source is GPL-3, but Existential Audio's compiled
  installer and branding are separately all-rights-reserved — this project
  never links or bundles BlackHole's source or binary; `helper/crates/audio/src/macos.rs`
  only deep-links to Existential Audio's official download page. Because
  nothing GPL-3-licensed is distributed by this project, no GPL obligation
  attaches to AI Notetaker itself.
- **VB-CABLE (Windows).** VB-Audio's EULA permits redistributing the free
  *base* driver package unmodified; this project stages only that pinned,
  checksummed base package (`packaging/windows/fetch-vb-cable.ps1`,
  verified against a release-owner-set `VB_CABLE_SHA256`) and launches the
  official signed vendor installer visibly, with `vb-audio.com` attribution
  and the donation link kept visible (enforced in
  `docs/helper-packaging.md`). The paid A+B/C+D variants are never fetched
  or bundled — confirmed by reading `fetch-vb-cable.ps1`, which only ever
  requests `Download_CABLE/VBCABLE_Driver_Pack45.zip`.
- **Linux.** Wraps the user's own PulseAudio/PipeWire null-sink facilities
  via `cpal`, `pactl`, and the distro-provided `parec` executable from
  `pulseaudio-utils`; no third-party driver is bundled, wrapped, or linked,
  so no separate license applies.

## Renewal

Re-run this check (dependency license scan + a fresh read of the BlackHole
and VB-CABLE vendor terms, since either vendor can change them) before every
tagged release, not just once here.
