# AI Notetaker — Production Readiness TODO

This tracks everything between the current state (architecture approved,
the first implementation pass) and a production-ready v1.0. Organized by the sub-project
roadmap in
[`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md),
plus the cross-cutting work every sub-project depends on.

Check items off as they land. If a decision here turns out wrong once
you're building, update the spec doc first, then this file — don't let
them drift apart.

## Workflow improvements (2026-09-21)

- [x] Guided audio preflight and short mic/speaker probe in onboarding and the
      popup; the helper reports platform-specific device guidance without
      sending audio over Native Messaging.
- [x] Meeting modes, bounded custom vocabulary, and custom summary
      instructions flow from extension settings into the helper prompt and
      are persisted with each local meeting.
- [x] Stable local action-item IDs, completion/due-date tracking, and a
      cross-meeting action inbox in both the extension and optional webapp;
      webapp updates remain authenticated and self-hosted.
- [ ] Validate the audio probe and complete meeting workflow on real macOS,
      Windows, and Linux devices with each supported meeting app; local tests
      cannot prove OS routing or provider behavior.

## Distribution and installation architecture (2026-09-21)

The approved direction is documented in
[`docs/superpowers/specs/2026-09-21-distribution-and-installation-architecture.md`](docs/superpowers/specs/2026-09-21-distribution-and-installation-architecture.md).
The desktop helper remains native; Docker is for the optional history webapp
only.

- [x] Add the release manifest schema/template covering helper/extension
      versions, protocol compatibility, OS/architecture artifacts, checksums,
      and package-manager metadata; publishing real signed values remains
      release-owner work.
- [x] Replace the onboarding's generic GitHub Releases link with an
      OS-detected install page and a manual platform override; GitHub Pages
      is enabled for the configured repository and the install site is live at
      `https://apercallc.github.io/ai-notetaker/`.
- [ ] Finish and test direct native installers, including release-owner
      signing/notarization and per-OS Native Messaging registration.
- [x] Add Homebrew Cask plus WinGet/Chocolatey templates and release-build
      rendering around pinned native artifacts; publishing packages remains
      release-owner work. npm stays limited to source builds.
- [x] Add `webapp/Dockerfile` and Docker Compose for the optional webapp and
      Postgres, with persistent storage, migrations, health checks, and
      authenticated token setup.
- [x] Add helper/extension protocol compatibility and a user-facing install
      health state for helper missing, incompatible, driver missing, routing
      incomplete, and ready.
- [ ] Complete acceptance testing for native installers, package-manager
      install/upgrade/uninstall, and Chrome Web Store/manual extension paths.
- [x] Docker webapp acceptance smoke test passes: image build, migrations,
      health endpoint, unauthenticated rejection, and authenticated API access;
      native OS and remote deployment proof remain release-owner work.

## Hardening pass (2026-09-21)

- [x] Crash recovery now excludes active in-process recordings, reprocesses
      each durable raw-audio tail from its persisted transcription cursor, and
      keeps failed summaries pending for a later retry.
- [x] Retry metadata, meeting metadata, and transcripts use atomic temp-file
      replacement; deleting a meeting removes its helper-owned raw audio and
      metadata as well as extension-local state.
- [x] Audio startup fails closed when either capture stream cannot be built;
      platform guidance now distinguishes the physical microphone from the
      virtual meeting-audio input.
- [x] MV3 helper reconnects replay active-recording state and route subsequent
      transcript/summary events to the new connection; optional webapp sync
      failures persist in a bounded local outbox.
- [x] Recording is blocked until consent is acknowledged, onboarding provider
      tests must pass before completion, and canonical webapp URLs cannot
      include a path or query that could redirect bearer-token delivery.
- [x] Local webapp integration tests have a one-command disposable Postgres
      runner (`webapp/npm run test:with-postgres`); ESLint 9 is configured and
      passes.
- [x] Retry completion is scoped per meeting, so one meeting's queued audio
      cannot block or strand another meeting's pending summary; empty but
      successful transcript retries are covered by regression tests.
- [x] Webapp meeting ingestion now caps streamed request bodies and aggregate
      transcript/action-item text, while the UI bounds pasted search URLs and
      serves static login assets without a session.

---

## Sub-project 1: Core capture + notes pipeline (MVP)

**Status (2026-09-21): first implementation pass landed, then reviewed and
fixed.** 86 Rust tests + 67 extension tests + 48 webapp tests, all
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
- **Webapp (originally):** no in-app way to end the 30-day session on a
  publicly-reachable self-hosted instance — added a sign-out action.
- **Webapp:** `.meeting-card:focus-visible` got a weaker focus cue (border
  color only) than text inputs (outline + offset) — unified.
- **Webapp:** a deleted/invalid meeting ID fell through to Next's default
  unstyled 404 — added a themed `not-found.tsx`.

*Design findings — fixed in the follow-up pass:*
- Extension: per-surface font sizes now use the shared rem-based scale.
- Extension: replaced-view headings receive keyboard focus after renders.
- Extension: the popup uses a scoped status live region instead of making
  the entire app a live region.
- Extension: recoverable-banner layout now uses a token-based CSS class.
- Webapp: pagination past 50 meetings, bounded search parameters, and
  pending indicators for login/delete/search are now implemented; search
  remains intentionally substring-based for the v1 Postgres query shape.
- Webapp/extension: accent, danger (now partially reconciled), and border-
  radius token values have drifted between the two surfaces' otherwise
  identically-structured theme files — needs a single shared source of
  truth instead of two hand-typed copies.
- Webapp: dead `.meta`-mimicking inline styles were replaced by named CSS
  classes; summary preview truncation remains intentionally bounded in both
  storage response and layout to protect long meeting lists.
- Webapp: per-line borders on every transcript segment may read as a
  dense "spreadsheet" grid at real (200+ segment) transcript length —
  flagged by the reviewer as needing a live visual check, not a code-only
  judgment call.
- Extension: helper-not-found retry backoff now uses `chrome.alarms` so MV3
  service-worker suspension does not cancel retries; non-Chrome test harnesses
  retain a `setTimeout` fallback.

*Efficiency pass (2026-09-21):*
- **Helper:** callback-sized audio is persisted immediately but sent to batch
  transcription in five-second windows, avoiding an HTTP request per cpal
  callback while flushing the final partial window before summarization.
- **Helper:** provider clients now have bounded connect/request timeouts, and
  provider responses append transcript batches in one disk rewrite.
- **Extension:** popup history reads only its newest five records, concurrent
  transcript updates are serialized, stale live listeners are removed, and
  webapp health/sync requests cannot hang indefinitely.
- **Webapp:** inbound meeting payloads and deep pagination are bounded before
  Prisma work, meeting chronology is validated, and titles are normalized.
- **Webapp:** transcript detail rows no longer form a dense full-width grid,
  and off-screen rows use browser content-visibility for long meetings.

### Desktop helper (`helper/`)

- [x] Scaffold Tauri project, shared Rust core + per-OS audio modules —
      Cargo workspace (`notetaker-core`, `notetaker-audio`, `notetaker-app`)
- [ ] macOS: detect-if-missing + deep-link to Existential Audio's official
      BlackHole download — **written but not compiled** (no macOS
      toolchain available to verify; module exists at
      `helper/crates/audio/src/macos.rs`)
- [x] Windows: release-only checksum-pinned staging of the base VB-CABLE
      package plus visible administrator installer launch is wired; the
      payload is intentionally not committed and Windows execution/reboot
      behavior remains release-owner validation. See
      `packaging/windows/` and `helper/crates/audio/src/windows.rs`.
- [x] Linux: PulseAudio/PipeWire null-sink integration — `cpal` + `pactl`,
      compiles and unit-tests pass (not hardware-verified — no audio
      device in this sandbox)
- [x] Dual-channel capture kept as separate streams — tested
      (`storage::tests::mic_and_speaker_channels_stay_in_separate_files`)
- [x] Raw audio always written to local disk before any API call — tested,
      confirmed by `notetaker-guardrails-reviewer`
- [x] Failed-chunk retry queue — persisted backoff queue plus an in-process
      worker now replays the exact saved PCM range, re-summarizes finalized
      meetings after late success, reports exhaustion, and reloads pending
      queue files after the next authenticated settings handshake; only an
      unqueued raw-audio tail after a crash remains a recovery follow-up.
- [x] Provider interface/trait for transcription providers
- [x] Provider interface/trait for summarization providers
- [ ] Deepgram integration — **implemented against the batch REST
      endpoint, not the live-streaming endpoint** the spec names as
      default; same trait, swappable later, tested with mocked HTTP
      (`wiremock`). The current UX is rolling five-second batch partials;
      true live WebSocket streaming remains a scoped follow-up.
- [x] Claude Haiku integration — tested
- [x] Groq Whisper Turbo integration — tested
- [x] Gemini Flash + DeepSeek V4 Flash integration — both implemented,
      tested
- [x] Native Messaging host: manifest template + pairing-token handshake —
      resolved via the two-binary split, see
      `docs/native-messaging-protocol.md`
- [x] Meeting summary + action-items prompt (Claude provider)
- [x] Local file format for stored transcripts/audio — tested
- [x] Tauri tray/app shell wired — `notetaker-helper` now has a plain
      Tauri-owned `main()`, IPC starts from `.setup()`, and the tray exposes
      idle/recording status, recent notes, notes folder, opt-in launch-at-login,
      and quit. Placeholder icon art is checked in; real branding remains.
- [x] Tauri auto-updater plugin and artifact configuration wired — updater
      public key, endpoint, and signing artifacts remain owner-only release
      setup; see `docs/helper-packaging.md`.
- [x] Startup check for an in-progress recording (crash recovery) —
      tested; resume reprocesses the durable raw-audio tail after the last
      persisted transcription cursor before finalizing the summary.
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
- [x] First-run onboarding wizard — per-OS setup cards and rendered UI
      screenshots are included; native-OS screenshots and execution remain
      release-owner validation
- [x] One-time consent-law disclosure
- [x] Dark mode support
- [x] Design pass — reviewed independently by `notetaker-design-reviewer`
      post-implementation (see review notes; any findings from that pass
      get applied before this is truly done)

### AI pipeline / cost transparency

- [x] Cost-per-meeting estimator shown in settings UI — duration-based
      estimates use the documented 45-minute tier figures and clearly warn
      users to recheck provider pricing before release/use
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
- [x] Per-OS setup guide written in `docs/helper-packaging.md`; native-OS
      screenshots and execution remain release-owner validation

---

## Sub-project 2: Cross-platform helper packaging polish

- [ ] macOS: Apple Developer ID signing + notarization (no "unidentified
      developer" wall on first launch)
- [ ] Windows: Authenticode code signing (no SmartScreen warning wall)
- [x] Linux: package for common formats — Tauri `.deb` + AppImage targets and
      cargo-deb metadata are configured; `.rpm` remains out of this slice.
- [x] Auto-launch-on-login option — tray menu action is opt-in and defaults
      to off.
- [x] Uninstall path documented per OS, including removing the virtual audio
      device cleanly — see `docs/helper-packaging.md`; native-OS execution
      remains release-owner validation.
- [x] First-run helper detection from the extension — the actionable
      not-found state landed in `b8e5270` and remains covered by extension
      tests.
- [x] Final per-OS installer registration of the Native Messaging manifest —
      Debian postinst/postrm scripts, Windows NSIS/PowerShell hooks, and
      guarded macOS app-bundled install/uninstall helpers are implemented;
      macOS DMG still requires the owner to run the helper after copying the
      app because DMG has no post-install phase.
- [ ] Generate and publish the owner-controlled Tauri updater key/endpoint —
      config placeholders are intentional until the release owner supplies
      signing credentials.

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

- [x] Focused security review of the Native Messaging token handshake —
      connection-level hello authentication, bounded relay frames, private
      Unix token/data permissions, and protocol documentation are aligned;
      live Chrome/helper handshake proof remains external validation
- [x] Focused security review of the webapp auth-token flow — fail-closed
      route protection, constant-time token checks, safe session cookie
      settings, open-redirect prevention, and bounded list parameters are
      covered; deployment-owner hardening remains environment-specific
- [x] `SECURITY.md` with a responsible-disclosure process and explicit
      privacy boundaries
- [x] Repository review confirms no telemetry/analytics calls to a
      project-operated server; provider and optional user-owned webapp calls
      remain the only outbound application paths
- [x] `docs/data-handling.md` documents storage locations, outbound paths,
      and deletion behavior

### Legal

- [ ] Consent-to-record disclosure text reviewed (not legal advice, but
      accurate about one/two-party consent variation) for both desktop and
      any future mobile surface
- [ ] License compliance check on bundled/wrapped drivers (BlackHole,
      VB-Cable licensing terms) and any AI provider SDKs used

### Testing & QA

- [x] Unit tests per package (helper Rust modules, extension logic, webapp
      API routes) — focused suites currently cover 86 Rust, 67 extension,
      and 48 webapp tests
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

- [x] Per-OS install + setup guide — `docs/getting-started.md`,
      `docs/helper-packaging.md`, and the extension onboarding device cards;
      rendered UI screenshots are in `docs/screenshots/`, while native-OS
      execution/screenshots remain release-owner validation
- [x] Webapp self-hosting/deploy guide — `webapp/README.md` documents local,
      Railway, auth-token, migration, and verification setup
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
