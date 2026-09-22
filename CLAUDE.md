# AI Notetaker — Project Guidance

Open-source, self-hosted, no-subscription alternative to CRISP/Krisp-style
AI meeting notetakers. Full architecture: see
[`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md).
Read it before making architectural changes — the decisions below exist for
reasons documented there.

## Non-negotiable constraints (from the design review)

These were deliberate resolutions to specific gaps — don't reintroduce them:

- **No subscription, no centrally-hosted backend run by this project.**
  Users bring their own AI API key(s) (BYOK) and, optionally, self-host the
  history web app on their own Railway account. Never add billing or a
  shared multi-tenant service operated by the project.
- **The desktop helper owns the AI pipeline, not the Chrome extension.**
  Manifest V3 service workers die after ~30s idle and cannot hold a
  connection for a 45-minute meeting. The extension is a thin UI that
  displays what the helper streams to it.
- **Extension↔helper communication uses Native Messaging, not an open
  localhost WebSocket.** An open port is reachable by any webpage's
  JavaScript (cross-site WebSocket hijacking); Native Messaging is
  OS-enforced and allowlisted to this extension's ID.
- **Don't build a custom virtual-audio driver.** Use existing open-source
  ones: BlackHole (macOS), VB-Cable (Windows), a PulseAudio/PipeWire
  null-sink module (Linux).
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
- **API keys live in `chrome.storage.local` only** — never `.sync`.
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
UX, CI, Tauri tray/packaging, and per-OS Native Messaging installer hooks are
implemented and tracked in `TODO.md`. OS signing/notarization, the macOS
post-copy registration step, live provider/meeting validation, and the
remaining polish items are still open.

## Out of scope for now

Mobile capture, multi-user/team features on the web app, non-Chrome browser
ports. These are documented as future sub-projects in the architecture spec
— don't build toward them prematurely (YAGNI).
