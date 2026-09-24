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

## Quality, error handling, and open-source operations (2026-09-21)

- [x] Add reproducible coverage commands and CI artifacts for every surface;
      the current deterministic gates report 96.20% extension lines and
      93.63% webapp lines, with 120 Rust tests green. Platform-native audio,
      Tauri tray, Chrome entrypoints, and rendered pages remain separate
      smoke-test concerns rather than being counted as fake unit coverage.
- [x] Expand unit and integration coverage for protocol validation, native
      messaging diagnostics, storage failures, retry recovery, webapp API
      limits, request-body streaming, and provider/webapp error responses.
- [x] Standardize webapp API error envelopes with safe generic 500 responses,
      request correlation IDs, and server-rendered retry boundaries; malformed
      action submissions now return user-visible recovery messages.
- [x] Remove normal-path helper storage `expect` calls, log fatal startup
      failures with context, and add tests for missing durable retry audio and
      pre-start audio callbacks.
- [x] Add open-source project operations: MIT license, security policy,
      CODEOWNERS, Dependabot configuration, and `docs/testing.md`.
- [ ] Run real browser/Chrome Native Messaging flows and provider/audio tests
      on supported OSes; source/tests/builds cannot prove a live helper pairing,
      virtual-device routing, or a real provider response.

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
- [x] Make package-manager installs and channel-specific upgrade commands the
      primary user documentation; keep source builds in the contributor path
      and document that npm/npx cannot replace the native helper installer.
- [x] Release workflow now uploads versioned native artifacts, a generated
      checksum manifest, and the optional webapp image to GitHub Releases and
      GHCR. External Homebrew/WinGet/Chocolatey publication remains owner work.
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

## Repository-wide quality audit (2026-09-23)

- [x] `escapeHtml` escapes quotes, so summarized action-item text (LLM
      output) can no longer break out of the HTML attributes every extension
      page interpolates it into and hang new attributes off the same tag.
- [x] Ordinary Native Messaging disconnects back off like not-found ones.
      "Helper installed but not running" makes the shim exit immediately,
      which previously spawned a fresh OS process per disconnect forever.
- [x] A stale Unix socket file left by an unclean shutdown is detected (by
      probing, not assumption) and removed, instead of permanently bricking
      the helper's IPC; the accept loop survives a transient accept error.
- [x] Startup recovery scans `<root>/meetings/` for `summary_pending`, so a
      meeting whose summarization failed with no queued chunks is picked back
      up rather than stranded; giving up on a chunk now summarizes the rest of
      the meeting instead of leaving it pending forever.
- [x] Atomic metadata/retry writes are genuinely atomic on Windows (the
      delete-then-rename special case opened a crash window that lost the
      file); retry backoff is jittered so a burst of failures stops retrying
      a rate-limited provider in lockstep.
- [x] A blank `pairing_token.txt` (truncate-then-crash) reads as unpaired
      instead of wedging the handshake forever; token comparison is
      constant-time.
- [x] Webapp user + membership creation is transactional — a half-created
      user could neither sign in nor be cleaned up, and permanently blocked
      bootstrap. Failed sign-ins are throttled per address (in-process; see
      `src/lib/loginThrottle.ts` for the single-instance caveat), expired
      sessions are reaped, meeting pagination has a tiebreaker, and the
      action inbox is bounded.
- [x] Team actions return expected failures instead of throwing them; Next
      masks a Server Action's thrown message in production, so "only the
      owner can add members" reached the user as a generic server error.
- [x] Webapp CI runs the lint and typecheck gates that already existed as
      scripts but nothing invoked; `calendar.ts` is inside the extension
      coverage floor.
- [ ] Move the login throttle into Postgres if this app is ever run with more
      than one instance — the in-process counter does not hold across
      replicas and resets on redeploy.

---

## Sub-project 1: Core capture + notes pipeline (MVP)

**Status (2026-09-21): first implementation pass landed, then reviewed and
fixed.** 93 Rust core unit tests + 1 Rust fixture integration test + 117
extension tests + 55 webapp tests, all
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
      BlackHole download — compiled by the macOS CI job, but still needs
      runtime validation on a real macOS install; module is at
      `helper/crates/audio/src/macos.rs`
- [x] Windows: release-only checksum-pinned staging of the base VB-CABLE
      package plus visible administrator installer launch is wired; the
      payload is intentionally not committed and Windows execution/reboot
      behavior remains release-owner validation. See
      `packaging/windows/` and `helper/crates/audio/src/windows.rs`.
- [x] Linux: PulseAudio/PipeWire null-sink integration — cpal keeps the
      default microphone capture, while `parec -d notetaker_sink.monitor
      --raw --format=s16le --rate=48000 --channels=2` captures the speaker
      monitor and `pactl list short sources` probes the exact virtual source
      names. The fake-`parec` contract test, full Rust tests, release build,
      and live PipeWire run are green. The live run completed the Native
      Messaging relay handshake, reported `ready: true`, passed the audio
      probe with mic and speaker frames while test audio played, and wrote
      non-empty `mic.pcm` and `speaker.pcm` files for a 30-second recording
      before any real provider key was used. The probe's active sources
      reported `RUNNING` during capture.
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
- [x] Deepgram integration — real WebSocket live-streaming implemented
      per `docs/superpowers/specs/2026-09-22-deepgram-live-streaming-design.md`;
      interim results replace an in-progress transcript line in place
      (extension), a WS drop backfills the gap via the existing batch
      retry queue while the session reconnects, and the batch REST path
      is retained for key-test and backfill. Tested against a real local
      WebSocket server (no live Deepgram credentials in this sandbox);
      a live handshake against Deepgram's real streaming endpoint with a
      real API key remains release-owner validation.
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
- [ ] "Deploy on Railway" one-click template — `webapp/railway.json` exists
      and its `startCommand` (`npm run db:migrate && npm run start`) checked
      against `webapp/package.json`'s real `db:migrate`/`start` scripts, so
      the config is internally consistent; **not verified**: an actual
      click-through deploy against a real Railway account and live Postgres
      addon, which spends real money and needs the release owner's own
      account — not something to trigger from this sandbox
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
      developer" wall on first launch) — `release-build.yml` now signs and
      notarizes automatically once the release owner adds
      `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY`/
      `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` repo secrets; see
      `docs/helper-packaging.md`. Still blocked on the release owner actually
      holding an Apple Developer Program membership.
- [ ] Windows: Authenticode code signing (no SmartScreen warning wall) —
      `release-build.yml` now signtool-signs every `.msi`/`.exe` once the
      release owner adds `WINDOWS_CERTIFICATE`/`WINDOWS_CERTIFICATE_PASSWORD`
      repo secrets; see `docs/helper-packaging.md`. Still blocked on the
      release owner actually holding a purchased code-signing certificate.
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

- [x] Cross-meeting search (extension local archive and webapp meeting list)
      — the extension searches titles, summaries, transcripts, and action
      items; the webapp searches titles, summaries, and transcript text.
- [x] Calendar integration — extension-only (metadata enrichment, not AI
      pipeline work). BYOK OAuth per user via chrome.identity.launchWebAuthFlow
      + PKCE, not a project-owned OAuth client (avoids Google's consent-
      screen verification requirement entirely). Best-effort: any failure
      falls back to today's default title with no attendees, never blocks
      a recording. See
      `docs/superpowers/specs/2026-09-22-calendar-integration-design.md`.
      A live OAuth popup and real Google/Microsoft account responses
      remain release-owner/manual verification — no such account exists
      in this sandbox.
- [x] Action-item tracking across meetings (extension and webapp action inboxes)
- [x] Export (Markdown/plain text/browser Print-to-PDF) for a meeting's notes
      — available in both extension and webapp meeting details.
- [x] Design pass via `notetaker-design-reviewer` for the expanded history
      surface (2026-09-23) — found and fixed: raw wire speaker IDs
      (`them-2`, etc.) were leaking into the webapp UI and both exports
      because `speakerLabel()` was never ported from the extension
      (`webapp/src/lib/types.ts`, applied in the meeting detail page and
      `ExportButtons.tsx`); a checked action-item box in the webapp didn't
      autosave like its extension counterpart, so a box-then-navigate-away
      silently lost the change (`webapp/src/components/ActionDoneCheckbox.tsx`,
      wired into both the meeting detail and cross-meeting inbox pages); the
      webapp had no secondary button style, so Export/Print/inbox-Save
      competed visually with real primary actions (`.button-secondary` in
      `globals.css`). See the fuller finding set folded into the
      accessibility item below.

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

- [x] Custom vocabulary support (bounded terms persisted in settings and sent
      to the helper prompt)
- [x] Richer summarization templates (meeting modes plus bounded custom
      instructions for sales calls, standups, 1:1s, interviews, and custom
      templates)
- [x] Cross-browser ports — Edge/Brave: helper now registers its Native
      Messaging host in both browsers' OS-specific locations (the actual
      gap; the extension code needed no changes). Firefox: real port —
      `browser_specific_settings.gecko.id`, `background.scripts`
      alongside `service_worker`, and a separate Native Messaging host
      manifest shape (`allowed_extensions`, not `allowed_origins`). See
      `docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`.
      Actually loading in real Edge/Brave/Firefox installs, and Mozilla
      AMO signing, remain release-owner validation.
- [x] Multi-user auth for the webapp — real per-user login (scrypt-hashed
      passwords, DB-backed sessions replacing the shared-token browser
      cookie), workspace-scoped meeting access, and an owner-only team
      management page. The `/api/*` `AUTH_TOKEN` ingestion contract is
      completely unchanged. Verified against a real Postgres via the
      project's own `test:with-postgres` runner (82 tests) plus a real
      `next build`, which caught two real Next.js constraints (a
      `next/headers` import bleeding into the Middleware/client bundle,
      and a non-function export from a `"use server"` file). See
      `docs/superpowers/specs/2026-09-22-webapp-multi-user-auth-design.md`.

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

- [x] Consent-to-record disclosure text reviewed for the desktop/extension
      surface — now explicitly names one-party vs. two-party consent and
      states it is general information, not legal advice
      (`extension/src/onboarding/onboarding.ts`). Not a substitute for an
      actual attorney review; mobile has no disclosure yet since sub-project
      4 (mobile capture) hasn't started.
- [x] License compliance check on bundled/wrapped drivers and AI provider
      SDKs — see `docs/third-party-licenses.md` (checked 2026-09-23): no
      vendor AI SDK is used anywhere (Deepgram/Claude/Groq/Gemini/DeepSeek
      are all called over plain HTTP/WS), BlackHole is never bundled (source
      GPL-3, binary all-rights-reserved, so no GPL obligation attaches),
      and only the free base VB-CABLE package is staged under VB-Audio's
      redistribution terms. Needs a re-check before each tagged release,
      not just this one-time pass.

### Testing & QA

- [x] Unit tests per package (helper Rust modules, extension logic, webapp
      API routes) — focused suites currently cover 93 Rust core unit tests
      plus 1 fixture integration test, 117 extension tests, and 55 webapp
      tests; see `docs/testing.md` for coverage scope and commands.
- [x] Integration test for the full pipeline using a committed PCM fixture
      against both default and budget provider paths (mocked provider
      responses in CI, no live API calls required) —
      `helper/crates/core/tests/full_pipeline.rs`
- [x] Accessibility audit (contrast, keyboard nav, screen reader labels)
      across all three UI surfaces (2026-09-23, static code-level pass via
      `notetaker-design-reviewer`, no live screen reader in this sandbox —
      that remains real-device validation). Fixed: onboarding and Settings
      never adopted the popup's keyboard-focus fix (a heading gets
      `tabindex="-1" data-view-heading` and is refocused after every
      re-render) — every Back/Continue click in the mandatory 4-step
      onboarding wizard, and every tier/calendar toggle in Settings, dropped
      keyboard focus to `document.body`
      (`extension/src/onboarding/onboarding.ts`,
      `extension/src/settings/settings.ts`); the tier-toggle buttons had no
      `aria-pressed`; three provider/webapp/calendar test-result regions had
      no `aria-live`; `global-error.tsx` never imported `globals.css`, so
      the true last-resort error screen would render in unstyled browser
      chrome; `meeting.ts`'s two early-return error states used a bare
      `<p>` instead of the file's own `role="alert"` pattern; the macOS tray
      icon reused the full-color dock icon with no `icon_as_template` flag
      (`helper/crates/app/src/tray.rs`); light-mode `--color-accent` sat at
      ~4.57:1 on white, right at the AA floor — darkened to ~6.5:1 for
      headroom. Full finding list (including the still-open items below)
      is in this session's `notetaker-design-reviewer` transcript.
- [x] `notetaker-design-reviewer` pass on every new or changed screen
      (2026-09-23) — see the accessibility item above for what it found and
      fixed. Also fixed the remaining low-severity findings: Settings'
      calendar Client ID/secret fields now link to the right OAuth console
      (Google Cloud Console credentials / Azure App registrations) instead
      of offering zero setup guidance; `team/page.tsx` no longer reuses
      `.meeting-card`'s hover/focus "this is clickable" cue for static rows
      (`.static-row` in `globals.css`); API key and webapp-token inputs
      across Settings now consistently set `autocomplete="off"`. Two
      findings intentionally left open — they need a live render, not a
      code fix: dense per-line transcript borders at 200+ segments, and
      real tray rendering in an OS menu bar.
- [x] `notetaker-guardrails-reviewer` pass before every release (2026-09-23)
      — reviewed all 11 non-negotiable constraints across `extension/`,
      `helper/`, and `webapp/` as they stand on `main`. Zero violations
      found; the recent calendar OAuth feature was checked specifically
      (BYOK, 5s-timeout-bounded, `chrome.storage.local`-only, never blocks
      `startRecording`) and confirmed correctly scoped.

### CI/CD & release

- [x] CI: build + test matrix for helper (macOS/Windows/Linux), extension,
      and webapp — `.github/workflows/helper.yml`, `extension.yml`, and
      `webapp.yml`; release bundles are built by `release-build.yml`.
- [ ] `notetaker-release` skill used for every version bump — helper and
      extension versions never drift apart
- [x] Chrome Web Store listing draft prepared (description, permission
      justification, privacy boundaries, and submission checklist) —
      `docs/chrome-web-store-listing.md`; store submission remains external.
- [x] Changelog started and release-owner maintenance process documented —
      `CHANGELOG.md`

### Documentation

- [x] Per-OS install + setup guide — `docs/getting-started.md`,
      `docs/helper-packaging.md`, and the extension onboarding device cards;
      rendered UI screenshots are in `docs/screenshots/`, while native-OS
      execution/screenshots remain release-owner validation
- [x] Webapp self-hosting/deploy guide — `webapp/README.md` documents local,
      Railway, auth-token, migration, and verification setup
- [x] `CONTRIBUTING.md` (local checks, architecture boundaries, and PR
      expectations)
- [x] `CODE_OF_CONDUCT.md`
- [x] Issue and PR templates
- [x] MIT license, security policy, CODEOWNERS, Dependabot updates, and
      reproducible coverage/testing documentation

### Community / open source readiness

- [x] Repo topics/description set for discoverability on the GitHub repository
- [x] GitHub's `good first issue` label is available for contributor issues
- [x] Public roadmap kept in sync with this file — `README.md` and
      `CONTRIBUTING.md` link directly to `TODO.md`, which distinguishes
      implementable work from release-owner and future-scope gates.

---

## How to use this file

- Pick items top-down within sub-project 1 before touching later
  sub-projects — the roadmap order in the spec is deliberate (each one
  depends on the one before it working).
- When a section's items are all checked, do a design + guardrails review
  pass before calling that sub-project done, not just at the very end.
- If scope changes (a gap turns out bigger or smaller than expected),
  update the architecture spec first, then reflect the change here.
