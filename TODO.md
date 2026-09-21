# AI Notetaker — Production Readiness TODO

This tracks everything between the current state (architecture approved,
no code yet) and a production-ready v1.0. Organized by the sub-project
roadmap in
[`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md),
plus the cross-cutting work every sub-project depends on.

Check items off as they land. If a decision here turns out wrong once
you're building, update the spec doc first, then this file — don't let
them drift apart.

---

## Sub-project 1: Core capture + notes pipeline (MVP)

### Desktop helper (`helper/`)

- [ ] Scaffold Tauri project, shared Rust core + per-OS audio modules
- [ ] macOS: detect-if-missing + deep-link to Existential Audio's official
      BlackHole download (do NOT bundle their binary — verified licensing
      gap, see spec §3.1: GPL source but all-rights-reserved compiled
      installer + branding)
- [ ] Windows: bundle + silently install base VB-CABLE only (not A+B/C+D),
      with vb-cable.com attribution and the donation option kept visible in
      the installer UI, per VB-Audio's stated bundling terms
- [ ] Linux: PulseAudio/PipeWire null-sink module integration
- [ ] Dual-channel capture: mic input and speaker/meeting output kept as
      separate streams (never merged before transcription)
- [ ] Raw audio always written to local disk before any API call
      (resilience guarantee — verify with `notetaker-guardrails-reviewer`)
- [ ] Failed-chunk retry queue (network blips, rate limits, bad keys)
- [ ] Provider interface/trait for transcription providers
- [ ] Provider interface/trait for summarization (LLM) providers
- [ ] Deepgram Nova-3 live-streaming integration (default transcription)
- [ ] Claude Haiku 4.5 integration (default summarization)
- [ ] Groq Whisper Turbo integration (budget transcription, batch-only —
      label clearly as choppier live partials)
- [ ] Gemini Flash / DeepSeek V4 Flash integration (budget summarization)
- [ ] Native Messaging host: register manifest per OS, token-based
      handshake with the extension
- [ ] Meeting summary + action-items prompt design and iteration
- [ ] Local file format for stored transcripts/audio (versioned, so future
      format changes don't orphan old meetings)
- [ ] Tauri auto-updater wired up and tested
- [ ] Startup check for an in-progress recording left by an unclean
      shutdown; offer to resume processing it from raw audio on disk
- [ ] Onboarding/install messaging is explicit that a reboot or re-login
      may be needed before the virtual device appears (known
      BlackHole/VB-Cable behavior — don't let users think install failed)

### Chrome extension (`extension/`)

- [ ] Manifest V3 scaffold, permissions kept minimal
- [ ] Native Messaging client (talks to helper only — no direct provider
      API calls; verify with `notetaker-guardrails-reviewer`)
- [ ] Popup UI: start/stop recording, live transcript view
- [ ] Persistent recording indicator (visible whenever capture is active)
- [ ] Settings page: API key entry per provider, default/budget tier
      toggle, "test key" validation
- [ ] Local meeting history list + note/action-items view
- [ ] `chrome.storage.local` schema for settings + note references
      (never `.sync` for keys — verify with guardrails reviewer)
- [ ] First-run onboarding wizard (install helper → select as mic/speaker,
      with per-platform screenshots → paste API key(s) → optional webapp
      setup)
- [ ] One-time consent-law disclosure shown during onboarding
- [ ] Dark mode support
- [ ] Design pass via `notetaker-design-reviewer` before first release

### AI pipeline / cost transparency

- [ ] Cost-per-meeting estimator shown in settings (using live or
      documented provider pricing)
- [ ] Cost table in README/spec kept in sync with actual provider pricing
      at release time (pricing drifts — verify, don't assume last
      session's numbers still hold)

### Optional self-hosted webapp (`webapp/`)

- [ ] Next.js + Postgres scaffold
- [ ] Schema: meetings, notes, action items — with `user_id`/
      `workspace_id` from day one even though MVP is single-user
- [ ] Auth: single generated token per deploy (no multi-user yet)
- [ ] API endpoint for the extension to POST finished notes
- [ ] Meeting list + search UI
- [ ] Meeting detail view (transcript, summary, action items)
- [ ] "Deploy on Railway" one-click template — verify it deploys clean
      with zero manual config beyond secrets
- [ ] Design pass via `notetaker-design-reviewer`

### Cross-cutting for sub-project 1

- [ ] End-to-end manual test: real meeting on each of Zoom, Google Meet,
      Microsoft Teams, Slack Huddles, on macOS and Windows at minimum
- [ ] `notetaker-guardrails-reviewer` run clean on the full initial
      implementation before first tag
- [ ] Per-OS setup guide written in `docs/`

---

## Sub-project 2: Cross-platform helper packaging polish

- [ ] macOS: Apple Developer ID signing + notarization (no "unidentified
      developer" wall on first launch)
- [ ] Windows: Authenticode code signing (no SmartScreen warning wall)
- [ ] Linux: package for common formats (AppImage at minimum; `.deb`/`.rpm`
      as reach)
- [ ] Auto-launch-on-login option (opt-in, not default)
- [ ] Uninstall path documented/tested per OS (including removing the
      virtual audio device cleanly)
- [ ] First-run helper detection from the extension (clear "helper not
      found" state with a fix-it link, not a silent failure)

---

## Sub-project 3: Meeting history & "all-in-one place"

- [ ] Cross-meeting search (local, and in the webapp if deployed)
- [ ] Calendar integration (Google Calendar / Outlook) to auto-label
      meetings and pre-fill attendees
- [ ] Action-item tracking across meetings (not just per-meeting)
- [ ] Export (Markdown/PDF/plain text) for a meeting's notes
- [ ] Design pass via `notetaker-design-reviewer` for the expanded history
      surface

---

## Sub-project 4: Mobile capture

Scope per the research findings in the architecture spec, §9 — cellular
call recording is out (blocked by OS/store policy on both platforms). Real
scope:

- [ ] Android app using `AudioPlaybackCapture`/`MediaProjection` to capture
      Zoom/Meet/Teams mobile app audio (genuinely feasible)
- [ ] iOS app using a manual ReplayKit "record, then join your meeting"
      flow (functional but not passive/background — set expectations in
      the UI accordingly)
- [ ] Decide sync path: does mobile write to the same local-first model, or
      does it require the self-hosted webapp to bridge devices? (Local
      storage on a phone doesn't have a "same machine" helper to talk to —
      needs its own design pass before building)
- [ ] Consent-law disclosure surfaced on mobile too

---

## Sub-project 5: Polish / extras

- [ ] Custom vocabulary support (industry/company-specific terms) where the
      chosen transcription provider supports it
- [ ] Richer summarization templates (e.g. sales call vs. standup vs.
      1:1 — different structures)
- [ ] Cross-browser ports: Edge and Brave first (near-zero-cost, same
      Manifest V3 base), Firefox as a real port (different extension APIs)
- [ ] Multi-user auth for the webapp (team/workspace sharing) — schema
      already supports this per sub-project 1; build the auth + sharing UI

---

## Cross-cutting production-readiness work

### Security & privacy

- [ ] Security review of the Native Messaging token handshake
- [ ] Security review of the webapp's auth-token flow (self-hosted, but
      still worth a real review since it's public-repo code others deploy)
- [ ] `SECURITY.md` with a responsible-disclosure process (real, even for
      an open-source hobby-scale project — users are trusting it with
      meeting audio)
- [ ] No telemetry/analytics phoning home to a project-operated server —
      confirm this stays true release over release (it's load-bearing for
      the "no data liability" pitch, not just a nice property)
- [ ] Data-handling doc: what's stored where (local disk, browser storage,
      user's own webapp deploy), and that the project never sees any of it

### Legal

- [ ] Consent-to-record disclosure text reviewed (not legal advice, but
      accurate about one/two-party consent variation) for both desktop and
      any future mobile surface
- [ ] License compliance check on bundled/wrapped drivers (BlackHole,
      VB-Cable licensing terms) and any AI provider SDKs used

### Testing & QA

- [ ] Unit tests per package (helper Rust modules, extension logic, webapp
      API routes)
- [ ] Integration test for the full pipeline using recorded fixture audio
      against both default and budget provider tiers (mocked provider
      responses in CI, no live API calls required)
- [ ] Accessibility audit (contrast, keyboard nav, screen reader labels)
      across all three UI surfaces
- [ ] `notetaker-design-reviewer` pass on every new or changed screen
- [ ] `notetaker-guardrails-reviewer` pass before every release

### CI/CD & release

- [ ] CI: build + test matrix for helper (macOS/Windows/Linux), extension,
      and webapp
- [ ] `notetaker-release` skill used for every version bump — helper and
      extension versions never drift apart
- [ ] Chrome Web Store listing prepared (screenshots, privacy justification
      for permissions requested, store review requirements)
- [ ] Changelog maintained per release

### Documentation

- [ ] Per-OS install + setup guide (already tracked under sub-project 1,
      called out again here as a release blocker, not optional)
- [ ] Webapp self-hosting/deploy guide
- [ ] `CONTRIBUTING.md` (how to build locally, PR expectations, which
      skills/agents contributors should run before opening a PR)
- [ ] `CODE_OF_CONDUCT.md`
- [ ] Issue and PR templates

### Community / open source readiness

- [ ] Repo topics/description set for discoverability
- [ ] "Good first issue" labeling once the initial implementation lands
- [ ] Public roadmap kept in sync with this file (or this file linked from
      the repo's issue tracker) so contributors know what's next

---

## How to use this file

- Pick items top-down within sub-project 1 before touching later
  sub-projects — the roadmap order in the spec is deliberate (each one
  depends on the one before it working).
- When a section's items are all checked, do a design + guardrails review
  pass before calling that sub-project done, not just at the very end.
- If scope changes (a gap turns out bigger or smaller than expected),
  update the architecture spec first, then reflect the change here.
