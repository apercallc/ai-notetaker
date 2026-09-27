# AI Notetaker — Project Guidance

Open-source, local-first, botless AI meeting notetaker with a free local BYOK
mode and an optional managed paid AI service. Full target architecture: see
[`docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`](docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md).
The 2026-09-21 document is the historical implementation baseline.
Read it before making architectural changes — the decisions below exist for
reasons documented there.

## Non-negotiable constraints (from the design review)

These were deliberate resolutions to specific gaps — don't reintroduce them:

- **Two supported execution modes.** Local BYOK remains free and requires no
  account. Managed mode is a project-operated, multi-tenant service where
  the project owns provider credentials, meters usage, and bills users.
  Self-hosted deployment remains supported for users who want their own
  storage and provider accounts.
- **Capture ownership follows the source.** The Chrome extension owns
  Google Meet tab capture: its offscreen document sends bounded mic/speaker
  chunks to the service worker, which persists them in extension IndexedDB
  before BYOK provider calls or Hosted AI uploads. The Rust/Tauri helper owns
  long-running desktop-call capture and local resilience for Zoom, Teams,
  Slack, and other apps. MV3 restarts are handled by rehydrating the active
  Meet record and chunk sequence from IndexedDB; the helper remains mandatory
  for desktop sources.
- **Extension↔helper communication uses Native Messaging, not an open
  localhost WebSocket.** An open port is reachable by any webpage's
  JavaScript (cross-site WebSocket hijacking); Native Messaging is
  OS-enforced and allowlisted to this extension's ID.
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
- **Local BYOK keys live in protected local storage only** — never `.sync`.
  Managed provider keys are server-side secrets and never reach the client.
- **Helper is built on Tauri (Rust)**, not Electron — smaller install, one
  shared codebase across OSes, built-in updater.
- **Extension `manifest.json` carries a committed, stable `key` field.**
  Native Messaging's host allowlist is keyed to the extension ID that field
  derives — regenerating it breaks every installed helper's handshake.
- **Every webapp route checks the auth token, including reads.** No
  "public by default" page — it sits on a public Railway URL.
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

Core capture, provider pipeline, Native Messaging, extension helper-detection
UX, CI, Tauri tray/packaging, per-OS Native Messaging installer hooks, and the
dual-mode managed processing contracts are implemented and tracked in
`TODO.md`. The dual-mode migration is tracked in
[`docs/superpowers/plans/2026-09-24-scribbl-dual-mode-product-migration.md`](docs/superpowers/plans/2026-09-24-scribbl-dual-mode-product-migration.md).
Managed hosted processing, billing, and native loopback adapters have local
tests and build gates; real deployment, provider, billing, browser, and native
OS acceptance gates still remain before advertising hosted mode as released.

## Out of scope for now

Mobile capture, cellular/PSTN interception, DRM/protected audio, and
non-Chrome browser ports remain out of scope. Desktop/browser meeting and
VoIP capture on macOS, Windows, and Linux is in scope. Team/workspace support
is now in scope for managed hosting and must remain workspace-isolated.
