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

**Status (2026-09-21): first implementation pass landed, then reviewed and
fixed.** 74 Rust tests + 40 extension tests + 38 webapp tests, all
independently re-run and verified green by the coordinator (not just taken
on the implementers' word) — see `docs/native-messaging-protocol.md` for a
real cross-package
integration detail (the two-binary IPC split) discovered during this pass.
Checked items below are genuinely built and tested; unchecked items with a
note are the honest remaining gap, not an oversight.

**Review pass (same day): `notetaker-guardrails-reviewer` + independent
`notetaker-design-reviewer` passes on the extension and webapp UI, run
after implementation rather than skipped.**

*Guardrails finding — fixed:* the extension's "test API key" feature called
Deepgram/Groq/Claude/Gemini/DeepSeek directly (`extension/src/lib/providerTest.ts`),
bypassing the helper. Fixed by adding a `test_provider_key`/
`provider_key_test_result` pair to the Native Messaging protocol — key
validation now round-trips through the helper like everything else. Re-verified:
zero references to any provider API domain remain anywhere in `extension/src/`.

*Design findings — fixed (high severity: a correctness bug and two AA
accessibility failures):*
- **Extension:** the transcript UI collapsed every non-"you" speaker into
  a single "Them" even though the data model (and Deepgram's diarization)
  distinguishes them — now renders "Them 2", "Them 3", etc. via a shared
  `speakerLabel()` (`extension/src/types.ts`).
- **Extension:** `--color-danger`/`--color-recording` (`#ff3b30` light /
  `#ff453a` dark) measured ~3.55:1 against white — below the 4.5:1 AA
  minimum — affecting the Stop button, "Test" result text, and the
  recording indicator label. Corrected to accessible values, with a
  separate `--color-danger-solid` token for filled buttons (text-on-bg and
  bg-with-white-text need different values, not one shared token).
- **Extension:** no toolbar signal on a failed recording — added a badge
  (cleared on next popup open) plus a live re-render out of the dead
  "recording" view, so a failure is visible whether or not the popup is
  open when it happens.
- **Extension:** `color-scheme: light dark` was missing, so native
  checkboxes/`<select>` ignored dark mode — added.
- **Extension:** red was reused for "recording live," "advisory," and
  "warning" simultaneously — added a dedicated `--color-warning` token and
  moved the onboarding caution callout and the recoverable-recording
  banner to it.
- **Extension:** onboarding step 2 shipped literal placeholder text
  ("Per-platform screenshots go here…") — replaced with real per-OS
  instructions (screenshots themselves still needed, see below).
- **Webapp:** `--color-danger` had no dark-mode override, so it stayed
  tuned for a white background (~3.4:1 against the dark bg) — fixed,
  reusing the extension's dark-mode danger value.
- **Webapp:** no in-app way to end the 30-day session on a
  publicly-reachable self-hosted instance — added a sign-out action.
- **Webapp:** `.meeting-card:focus-visible` got a weaker focus cue (border
  color only) than text inputs (outline + offset) — unified.
- **Webapp:** a deleted/invalid meeting ID fell through to Next's default
  unstyled 404 — added a themed `not-found.tsx`.

*Design findings — deliberately deferred, not silently dropped (tracked
here for a follow-up pass, ranked by the reviewers' own priority order):*
- Extension: hardcoded `px` font sizes in per-surface CSS files beyond the
  base scale (only `theme.css`'s body/html were fixed earlier) — needs an
  `em`/`rem` sweep across `popup.css`/`settings.css`/`meeting.css`.
- Extension: full-page re-renders on every step/interaction drop keyboard
  focus back to `<body>` instead of moving it to the new view — needs a
  `tabindex="-1"` + `.focus()` pattern after each `render()`.
- Extension: `aria-live="polite"` on the whole popup `#app`, stacked on
  top of the transcript's own implicit `role="log"` live region — risks
  double-announcing to screen readers; needs a scoped status element
  instead of the outer wrapper.
- Extension: one inline `style="display:flex; gap: 8px;"` in `popup.ts`
  instead of a token-based class (minor, cosmetic-only).
- Webapp: no pagination past 50 meetings, and search is substring-only —
  once a user has >50 meetings, older ones become unreachable without
  remembering exact search terms.
- Webapp: no pending/in-flight indicator on login/delete/search actions
  (a Railway free-tier cold start makes this a real, not theoretical, gap).
- Webapp/extension: accent, danger (now partially reconciled), and border-
  radius token values have drifted between the two surfaces' otherwise
  identically-structured theme files — needs a single shared source of
  truth instead of two hand-typed copies.
- Webapp: a dead `.meta`-mimicking inline style and a redundant
  server-side + CSS double-truncation of meeting summaries — cleanup, not
  a functional bug.
- Webapp: per-line borders on every transcript segment may read as a
  dense "spreadsheet" grid at real (200+ segment) transcript length —
  flagged by the reviewer as needing a live visual check, not a code-only
  judgment call.

### Desktop helper (`helper/`)

- [x] Scaffold Tauri project, shared Rust core + per-OS audio modules —
      Cargo workspace (`notetaker-core`, `notetaker-audio`, `notetaker-app`)
- [ ] macOS: detect-if-missing + deep-link to Existential Audio's official
      BlackHole download — **written but not compiled** (no macOS
      toolchain available to verify; module exists at
      `helper/crates/audio/src/macos.rs`)
- [ ] Windows: bundle + silently install base VB-CABLE only — **written
      but not compiled**, and the actual binary fetch/embed step
      intentionally errors rather than fakes success (no network access to
      pull VB-Audio's real installer in this environment); module at
      `helper/crates/audio/src/windows.rs`
- [x] Linux: PulseAudio/PipeWire null-sink integration — `cpal` + `pactl`,
      compiles and unit-tests pass (not hardware-verified — no audio
      device in this sandbox)
- [x] Dual-channel capture kept as separate streams — tested
      (`storage::tests::mic_and_speaker_channels_stay_in_separate_files`)
- [x] Raw audio always written to local disk before any API call — tested,
      confirmed by `notetaker-guardrails-reviewer`
- [x] Failed-chunk retry queue — tested (`resilience.rs`: backoff, persist,
      exhaustion)
- [x] Provider interface/trait for transcription providers
- [x] Provider interface/trait for summarization providers
- [ ] Deepgram integration — **implemented against the batch REST
      endpoint, not the live-streaming endpoint** the spec names as
      default; same trait, swappable later, tested with mocked HTTP
      (`wiremock`)
- [x] Claude Haiku integration — tested
- [x] Groq Whisper Turbo integration — tested
- [x] Gemini Flash + DeepSeek V4 Flash integration — both implemented,
      tested
- [x] Native Messaging host: manifest template + pairing-token handshake —
      resolved via the two-binary split, see
      `docs/native-messaging-protocol.md`
- [x] Meeting summary + action-items prompt (Claude provider)
- [x] Local file format for stored transcripts/audio — tested
- [ ] Tauri auto-updater wired up and tested — **not done**; tray icon /
      Tauri app-shell integration deferred (documented integration plan in
      `helper/crates/app/src/tray.rs`, needs a `main()` restructure for
      Tauri's macOS main-thread requirement)
- [x] Startup check for an in-progress recording (crash recovery) —
      tested; note: resume currently finalizes the existing transcript
      rather than reprocessing the last unsent audio segment (the audio
      itself is never lost — that guarantee holds, the *resume* UX is
      simplified for now)
- [x] Onboarding/install messaging about reboot/re-login — copy exists in
      the extension's onboarding wizard

### Chrome extension (`extension/`)

- [x] Manifest V3 scaffold, TypeScript, minimal permissions — committed
      stable `key` field verified to derive extension ID
      `jidooookkdbbbhkkdmcajnnnhhphodok`
- [x] Native Messaging client — implements the full protocol, auto-reconnect
      for MV3 service-worker teardown; tested with mocks. **Not verified**:
      an actual live handshake against a real running helper process (no
      real Chrome + helper pairing available in this sandbox)
- [x] Popup UI: start/stop, live transcript view
- [x] Persistent recording indicator (respects `prefers-reduced-motion`)
- [x] Settings page: API key entry, tier toggle, "test key" validation —
      **not verified**: real provider API calls (no live keys in this
      sandbox)
- [x] Local meeting history list + note/action-items detail view
- [x] `chrome.storage.local` only, never `.sync` — confirmed by
      `notetaker-guardrails-reviewer`
- [x] First-run onboarding wizard — real per-platform screenshots still
      needed (wizard has placeholder copy, not actual screenshots)
- [x] One-time consent-law disclosure
- [x] Dark mode support
- [x] Design pass — reviewed independently by `notetaker-design-reviewer`
      post-implementation (see review notes; any findings from that pass
      get applied before this is truly done)

### AI pipeline / cost transparency

- [ ] Cost-per-meeting estimator shown in settings UI — **not built**;
      settings page has key entry/testing but no live cost calculator yet
- [x] Cost table already in `README.md`/spec — needs a re-check against
      live pricing at actual release time, not now

### Optional self-hosted webapp (`webapp/`)

- [x] Next.js 16 (App Router) + Prisma + Postgres scaffold
- [x] Schema with `userId`/`workspaceId` on every table from day one
- [x] Auth: single generated token, enforced on every route (Bearer for
      API, session cookie for the browser UI) except `GET /api/health` —
      verified by `notetaker-guardrails-reviewer` and by dedicated auth
      tests run against a real Postgres
- [x] `POST /api/meetings` idempotent upsert endpoint
- [x] Meeting list + search UI
- [x] Meeting detail view (transcript, summary, action items) + delete
      with a confirmation dialog
- [ ] "Deploy on Railway" one-click template — `railway.json` exists;
      **not verified**: an actual click-through deploy against a real
      Railway account and live Postgres addon
- [x] Design pass — reviewed independently by `notetaker-design-reviewer`
      post-implementation

### Cross-cutting for sub-project 1

- [ ] End-to-end manual test: real meeting on each of Zoom, Google Meet,
      Microsoft Teams, Slack Huddles, on macOS and Windows at minimum —
      **not done**, needs a live meeting with real participants and real
      OS installs, outside what's possible in this sandbox
- [x] `notetaker-guardrails-reviewer` run against the full implementation
      — see review notes; findings addressed before this is checked off
      for real
- [ ] Per-OS setup guide written in `docs/` — package-level READMEs exist
      (`helper/README.md`, `webapp/README.md`, `extension/README.md`) but
      the user-facing, screenshot-driven per-OS guide promised in the
      onboarding wizard still needs to be written

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
