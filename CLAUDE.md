# AI Notetaker — Project Guidance

Open-source, local-first, botless AI meeting notetaker. The approved product
direction is one Tauri desktop app for setup, capture, local notes, and optional
web-app sync. See
[`docs/superpowers/specs/2026-10-03-desktop-first-product-design.md`](docs/superpowers/specs/2026-10-03-desktop-first-product-design.md)
and its active migration plan. The 2026-09-24 dual-mode and 2026-09-21 designs
document existing contracts and implementation history; the desktop-first spec
supersedes their extension-owned processing path for new product work. The
optional Chrome extension is now a Google Meet audio recorder: it saves
separate local tracks for desktop import.

## Non-negotiable constraints (from the design review)

These were deliberate resolutions to specific gaps — don't reintroduce them:

- **The Tauri desktop app is the primary product.** It owns setup, capture,
  provider calls, local notes, recovery, and optional web-app sync. The
  extension records Google Meet audio only for new calls. Historical notes,
  credentials, and recovery controls remain accessible during migration.
- **Local BYOK remains account-free.** The desktop app calls the user's
  selected providers directly. Optional web-app sync uses a separate
  authenticated API token; it never receives provider keys.
- **Desktop UI ↔ Rust uses Tauri IPC.** Do not add an open TCP/localhost
  listener. Native Messaging remains only as a temporary compatibility path
  for installed extensions and is not required by new customers.
- **Don't build a custom virtual-audio driver.** Prefer native OS loopback
  capture: ScreenCaptureKit/native audio on macOS, WASAPI loopback on Windows,
  and PipeWire/PulseAudio monitor sources on Linux. Keep BlackHole, VB-CABLE,
  and null-sink routing as documented fallbacks.
- **BlackHole and VB-Cable have different, verified redistribution terms.**
  Never bundle BlackHole's compiled installer (link out to Existential
  Audio's official download instead — their binary/branding are
  all-rights-reserved despite GPL source). Base VB-CABLE (never A+B/C+D)
  may be bundled on Windows only as a checksum-pinned release payload; the
  helper launches the vendor installer visibly with vb-cable.com attribution
  and the donation option kept visible in our installer experience.
- **Capture mic and speaker as separate channels**, not one mixed blob —
  this is what makes "you vs. everyone else" diarization free.
- **Raw audio is always saved locally first**, independent of any API call
  succeeding, so a transcription/summarization failure never loses data.
- **Local BYOK keys live in OS credential storage.** Never put them in synced
  storage or web-app requests.
- **The desktop app is built on Tauri (Rust)**, not Electron — smaller install, one
  shared codebase across OSes. Updates are an update-check tray item that opens
  the signed-release page (`docs/helper-packaging.md`); an in-place Tauri
  updater waits on release-signing keys.
- **Preserve extension compatibility during migration.** Do not change the
  committed manifest key, remove the Native Messaging relay, or delete
  extension data until the desktop app and migration path pass acceptance.
  New Meet captures do not call AI providers in Chrome or start desktop calls
  through the extension.
- **Every webapp data route authenticates its client.** Browser pages use a
  user session; managed APIs use their scoped auth; desktop note sync uses a
  revocable user token bound to one workspace. The legacy `/api/meetings`
  contract keeps its self-hosted `AUTH_TOKEN`. The only public web routes are
  the health check and the managed deployment's exact marketing allowlist in
  `webapp/src/marketing/paths.ts`.
- **Helper checks for and offers to resume an in-progress recording on
  startup** — an unclean shutdown must not silently orphan raw audio
  that's already on disk.

## Repo structure

```
extension/   # Chrome extension (Manifest V3) — see extension/CLAUDE.md
helper/      # Tauri/Rust desktop capture helper — see helper/CLAUDE.md
webapp/      # Optional Next.js + Postgres history app — see webapp/CLAUDE.md
docs/        # Setup guides, architecture specs
```

Each package has its own `CLAUDE.md` with tech-specific conventions — read
the one for whichever package you're touching in addition to this file.

## Project tooling

- **`notetaker-guardrails-reviewer` agent** — checks a diff against the
  non-negotiable constraints above. Run it before committing or opening a
  PR that touches `extension/`, `helper/`, or `webapp/`.
- **`notetaker-release` skill** — coordinates a version bump + build across
  the helper (all three OSes) and the extension together, since they must
  ship in lockstep (they share a Native Messaging version handshake).
- **`notetaker-add-provider` skill** — scaffolds a new BYOK transcription
  or LLM provider integration so it follows the same interface, resilience,
  and cost-documentation pattern as the existing ones.
- **`notetaker-design-reviewer` agent** (via the `notetaker-design-review`
  skill) — an Apple-caliber design critique of any UI/UX work across the
  extension popup, onboarding wizard, helper tray/menu, or webapp. "Great
  user experience" is a founding pillar, not an afterthought — run this
  after building or changing any screen, component, or user-facing copy.

## Current status

Capture, provider pipeline, Tauri app and tray, native loopback adapters,
Native Messaging compatibility, and web-app APIs exist. The desktop app now
owns setup, local recording/history, and optional workspace-scoped text sync.
Cross-platform release packaging, migration of raw extension audio and
unfinished recordings, and real recording/sync acceptance remain open. A
bounded transfer for completed text notes and non-secret preferences exists;
the source extension data stays untouched. Desktop-first work is active in
[`docs/superpowers/plans/2026-10-03-desktop-first-product-migration.md`](docs/superpowers/plans/2026-10-03-desktop-first-product-migration.md).
Do not describe the one-app workflow as shipped until native runtime and
existing-data migration gates pass.

## Out of scope for now

Mobile capture, cellular/PSTN interception, DRM/protected audio, and
non-Chrome browser ports remain out of scope. Desktop/browser meeting and
VoIP capture on macOS, Windows, and Linux is in scope. Team/workspace support
is now in scope for managed hosting and must remain workspace-isolated.
