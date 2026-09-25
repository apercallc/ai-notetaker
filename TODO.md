# AI Notetaker — Production Readiness and Product Migration TODO

This tracks the current implementation baseline, the approved Scribbl-like
dual-mode migration, and the remaining production gates. The current target
architecture is
[`docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`](docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md);
the 2026-09-21 architecture is historical.

Check items off as they land. If a decision here turns out wrong once
you're building, update the spec doc first, then this file — don't let
them drift apart. Scope is governed by the root `CLAUDE.md`: anything it lists
as out of scope (mobile capture, cellular/PSTN, DRM audio, non-Chrome browser
ports) lives under "Ideas" at the bottom, not in the roadmap.

## Approved product migration (2026-09-24)

Implementation plan:
[`docs/superpowers/plans/2026-09-24-scribbl-dual-mode-product-migration.md`](docs/superpowers/plans/2026-09-24-scribbl-dual-mode-product-migration.md)

- [x] Approve dual-mode product direction: free local BYOK plus paid hosted AI.
- [x] Define botless Google Meet capture as a first-class recording source.
- [x] Define native loopback capture for macOS, Windows, and Linux, with
      existing virtual-audio fallbacks.
- [x] Define hosted auth, workspace isolation, resumable uploads, private
      object storage, workers, usage ledger, retention, sharing, and billing.
- [x] Implement an owner-controlled managed retention policy with asynchronous
      meeting, transcript, share, and private-audio deletion.
- [x] Enable managed-hosting signup to provision isolated customer workspaces;
      keep self-hosted bootstrap single-workspace and setup-token protected.
- [x] Add managed deployment readiness diagnostics to `/api/health` without
      exposing provider, worker, Stripe, or storage secrets.
- [x] Implement mode-neutral capture/processing contracts and protocol v3.
- [x] Implement the macOS ScreenCaptureKit system-audio adapter with
      Screen Recording permission metadata and BlackHole fallback guidance.
      Windows now uses a real WASAPI shared-mode loopback reader; physical
      macOS, Windows, and Linux smoke tests remain.
- [x] Implement managed upload/job APIs, durable object storage, and provider workers.
- [x] Bound hosted Deepgram/Anthropic calls with cancellation, transient retry,
      `Retry-After` handling, and fail-fast permanent provider errors.
- [x] Add a token-protected `/api/v1/jobs/next` worker-polling endpoint with
      database-side single-claim protection for horizontally scaled hosts.
- [x] Add an S3-compatible private object-storage backend for multi-instance
      hosting while retaining the persistent-volume fallback for self-hosted
      Docker deployments; configuration and adapter tests are documented.
- [x] Implement hosted billing, Stripe retry idempotency, and entitlement enforcement.
- [x] Enforce managed upload checksums and streamed body limits; release failed
      processing reservations so retries do not burn successful-operation quota.
- [x] Reap expired managed upload rows and private chunk objects from the worker
      heartbeat; expiry races cannot resurrect an abandoned upload, and a
      storage-delete failure leaves the expired row retryable instead of
      orphaning the private object.
- [x] Implement expiring private meeting shares, revocation, and managed mic/speaker recording downloads.
- [x] Connect the extension/helper to managed mode and the workspace library.
- [x] Restrict managed API CORS to the fixed extension origin (or an explicit
      controlled-fork origin) instead of wildcard bearer-authenticated access.
- [x] Request a least-privilege optional Chrome host permission for the
      user-selected hosted service origin during explicit Hosted AI sign-in;
      local BYOK never requests that permission.
- [x] Persist managed upload/job state in helper metadata and resume hosted
      uploads or job polling after a helper restart.
- [x] Retry transient managed upload failures automatically with bounded
      exponential backoff; idempotent meeting/upload/chunk keys make retries
      safe without duplicate hosted work.
- [x] Register extension-owned Meet meetings in the authenticated managed
      workspace before upload; preserve retry idempotency and reject
      cross-workspace client-ID reuse.
- [x] Make first-run onboarding Meet-first: choosing Google Meet stays in the
      browser-owned capture path without a helper-download screen. Desktop-call
      setup remains an explicit helper path, and Meet does not redirect to it
      when the helper is absent.
- [x] Keep ordinary onboarding links Meet-first; only the explicit desktop-call
      choice opens the native-helper install section.
- [x] Keep stale public install URLs and copied internal onboarding tabs
      Meet-first; the public helper section requires `source=desktop`, while
      internal helper onboarding also requires a short-lived explicit session
      intent from the desktop-capture action.
- [x] Keep the completed popup Meet-first even outside a Meet tab; do not show
      or open desktop-helper setup until the user explicitly selects desktop
      capture.
- [x] Make extension updates migrate already-open onboarding tabs from the
      helper-first legacy bundle to the canonical Meet-first URL. (Superseded
      for fresh installs: the new flow auto-opens one-screen onboarding on
      install; see `docs/getting-started.md`.)
- [x] Link Hosted AI onboarding and Settings directly to the hosted
      login/signup page after validating the configured HTTPS service URL; local
      BYOK remains account-free.
- [x] Preflight server-authoritative Hosted AI entitlements before recording;
      inactive plans and exhausted quotas are shown before a meeting starts.
- [x] Make Meet capture retryable when its tab closes, navigates, or its
      offscreen audio pipeline reports an error; already-persisted audio stays
      available for recovery.
- [x] Make Meet teardown idempotent when the offscreen document or runtime
      message fails, so a stale capture cannot block the next recording.
- [x] Keep completed Meet notes complete when best-effort IndexedDB audio cleanup
      fails; retained raw chunks remain available for later cleanup.
- [x] Bound browser-owned BYOK provider requests with cancellation, transient
      retry, bounded `Retry-After` handling, and fail-fast permanent errors;
      durable Meet chunks remain available when all attempts fail.
- [x] Resume extension-owned managed Meet processing records after an MV3
      worker suspension when Hosted AI is still active; local chunks remain
      durable. A fresh hosted sign-in now serializes a durable outbox drain for
      interrupted and recoverable managed-error Meet records while excluding
      local-BYOK meetings.
- [x] Bind durable managed Meet and desktop-helper retries to their original
      account/workspace identity; switching hosted workspaces fails closed
      instead of moving an old recording into the new tenant.
- [ ] Complete real Chrome/Meet, provider, deployment, storage, and billing
      acceptance evidence before advertising hosted mode.

## Pre-launch decisions (product audit, 2026-09-24)

Open product and release decisions found by the documentation and product
coherence audit. Each needs an owner decision before public launch; none is
decided yet.

- [ ] (a) Make **Hosted** the primary onboarding call to action, with a
      baked-in service URL (no URL to type) and a free trial, and move the
      bring-your-own-keys path under a secondary **Use my own keys** option.
      Today onboarding treats both modes as equals and Hosted needs a
      user-entered service URL. Requires the trial/quota policy from the design
      spec (section 6) to be affordable first.
- [x] Implement a project-owned **server** Google OAuth client for Calendar and
      Drive: per-user encrypted-at-rest connections, CSRF state + PKCE callback,
      authenticated extension endpoints, and account connect/disconnect controls.
      Google consent-screen verification plus a live credential/configuration
      test remain release-owner work; legacy extension BYOK setup remains a
      separate compatibility path until it is explicitly removed.
- [ ] (c) Move `nativeMessaging`, `identity`, `alarms`, and the five AI provider
      host permissions (Deepgram, Anthropic, Groq, Gemini, DeepSeek) to
      optional permissions requested when the feature is first used, so the
      install prompt for a Meet-only user is minimal.
- [ ] (d) Replace the committed development extension ID in the Native
      Messaging `allowed_origins` with the real Chrome Web Store extension ID
      once the listing exists, and verify the committed manifest `key`
      derives the published ID (or add both origins deliberately).
- [ ] (e) Generate and protect the Tauri updater signing key and set the
      updater endpoint so the automatic updater can be enabled (see also the
      Sub-project 2 updater item).
- [ ] (f) Capture real store screenshots on each OS (macOS, Windows, Linux) for
      the Chrome Web Store listing, the install page, and the README; current
      screenshots are rendered extension UI only.
- [ ] (g) Decide the helper's launch-at-login default (currently off) and have
      the installer or first launch register the Native Messaging manifests
      automatically, including the macOS DMG post-copy step that today is
      manual.

The legacy checklist below records work already landed against the original
local/BYOK architecture and remains as regression coverage while the
migration lands. New work must use the migration plan rather than silently
reintroducing its old assumptions.

## Workflow improvements (2026-09-21)

- [x] Guided desktop audio preflight and short mic/speaker probe in onboarding
      and the popup; Google Meet additionally has a separate browser-capture
      path for users who do not want virtual-device routing.
- [x] Meeting modes, bounded custom vocabulary, and custom summary
      instructions flow from extension settings into the helper prompt and
      are persisted with each local meeting.
- [x] Stable local action-item IDs, completion/due-date tracking, and a
      cross-meeting action inbox in both the extension and optional webapp;
      webapp updates remain authenticated and self-hosted.
- [ ] Validate the audio probe and complete meeting workflow on real macOS,
      Windows, and Linux devices with each supported meeting app; local tests
      cannot prove OS routing or provider behavior. On 2026-09-24, the current
      Linux host passed a real helper/Native Messaging protocol-v3 check and a
      PipeWire/PulseAudio probe (42 microphone frames, 4 speaker frames);
      macOS, Windows, and end-to-end provider/meeting checks remain open.

## Quality, error handling, and open-source operations (2026-09-21)

- [x] Sentry error handling (2026-09-25): webapp server (`instrumentation-server.ts`
      + `lib/observability.ts` capture on API 500s, Stripe webhook, managed job
      runs), client (`instrumentation-client.ts` + error boundaries, CSP
      connect-src extended only when a DSN is configured), and the managed
      worker script — all strictly DSN-gated so self-hosted builds have zero
      telemetry. Extension Hosted-AI mode reports bounded, deduplicated error
      records to a new authenticated, rate-limited
      `/api/v1/client-errors` endpoint; local BYOK never reports. Releases tag
      from `RAILWAY_GIT_COMMIT_SHA`. The helper intentionally stays
      local-logs-only (privacy boundary, documented in `docs/data-handling.md`).
      Live Sentry DSN configuration on the managed deployment remains
      release-owner work.
- [x] Add reproducible coverage commands and CI artifacts for every surface;
      the current deterministic gates report 96.20% extension lines and
      93.63% webapp lines, with 152 Rust tests, 382 extension tests, and 151
      webapp tests green in the current full run. Platform-native audio,
      Tauri tray, Chrome entrypoints, and rendered pages remain separate
      smoke-test concerns rather than being counted as fake unit coverage.
- [x] Expand unit and integration coverage for protocol validation, native
      messaging diagnostics, storage failures, retry recovery, webapp API
      limits, request-body streaming, and provider/webapp error responses.
- [x] Preserve old helper metadata when managed upload fields are absent, and
      persist the managed upload ID plus next-chunk cursor across helper restarts.
- [x] Standardize webapp API error envelopes with safe generic 500 responses,
      request correlation IDs (including proxy-level auth rejections), and
      server-rendered retry boundaries; malformed action submissions now return
      user-visible recovery messages.
- [x] Remove normal-path helper storage `expect` calls, log fatal startup
      failures with context, and add tests for missing durable retry audio and
      pre-start audio callbacks.
- [x] Add open-source project operations: MIT license, security policy,
      CODEOWNERS, Dependabot configuration, and `docs/testing.md`.
- [ ] Run real browser/Chrome Native Messaging flows and provider/audio tests
      on supported OSes; source/tests/builds cannot prove a live helper pairing,
      virtual-device routing, or a real provider response. Linux Native
      Messaging and native-loopback audio are now verified on the current host;
      other OSes and live provider responses remain unverified.

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
- [x] Keep the release registry Compose file aligned with managed worker,
      provider, billing, and S3 storage configuration instead of publishing an
      image that silently runs in an incomplete hosted mode.
- [x] Add helper/extension protocol compatibility and a user-facing install
      health state for helper missing, incompatible, driver missing, routing
      incomplete, and ready.
- [ ] Complete acceptance testing for native installers, package-manager
      install/upgrade/uninstall, and Chrome Web Store/manual extension paths.
- [x] Docker webapp acceptance smoke test passes: image build, migrations,
      health endpoint, unauthenticated rejection, and authenticated API access;
      native OS and remote deployment proof remain release-owner work. The
      current managed stack also verified a running worker and 401 managed
      sign-in for unknown credentials; a separate self-hosted stack verified
      managed sign-in fails closed with HTTP 404.
- [x] Managed billing route smoke coverage accepts a signed Stripe webhook,
      rejects invalid signatures, and ignores duplicate event delivery against
      disposable Postgres; live Stripe test-mode delivery remains open.

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
      bootstrap. Failed sign-ins are throttled per address in Postgres,
      expired sessions are reaped, meeting pagination has a tiebreaker, and the
      action inbox is bounded.
- [x] Team actions return expected failures instead of throwing them; Next
      masks a Server Action's thrown message in production, so "only the
      owner can add members" reached the user as a generic server error.
- [x] Webapp CI runs the lint and typecheck gates that already existed as
      scripts but nothing invoked; `calendar.ts` is inside the extension
      coverage floor.
- [x] Move the login throttle into Postgres so managed hosting shares the
      failed-login budget across replicas and deploys.

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

*Guardrails finding — fixed (historical; superseded):* under the 2026-09-21
"pipeline lives in the helper" rule, the extension's "test API key" feature was
moved to a `test_provider_key`/`provider_key_test_result` round-trip through the
helper, and `extension/src/` had no provider API domains. The 2026-09-24
design supersedes that rule for Google Meet: the extension owns Meet capture and
its BYOK provider calls, so browser-side provider clients are now correct. The
guardrails reviewer no longer enforces the old rule.

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
- [x] macOS: use native ScreenCaptureKit system-audio capture on macOS 13+
      with Screen Recording permission metadata and retain detect-if-missing +
      deep-link guidance for the official BlackHole fallback; module is at
      `helper/crates/audio/src/macos.rs`. Physical runtime validation remains
      in the OS smoke-test item above.
- [x] Windows: default-output WASAPI shared-mode loopback capture is wired and
      downmixes native float frames to the helper's PCM16 speaker channel;
      release-only checksum-pinned staging of the base VB-CABLE package plus
      visible administrator installer launch remains the explicit fallback.
      The payload is intentionally not committed and Windows execution/reboot
      behavior remains release-owner validation. See `packaging/windows/` and
      `helper/crates/audio/src/windows.rs`.
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
      reported `RUNNING` during capture. The real raw-recording proof produced
      non-empty mic and speaker files; the direct synthetic probe's speaker
      counter still needs a follow-up before it is called fully green.
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
      for MV3 service-worker teardown, and stale-token recovery. Verified with
      a live Chrome-for-Testing + rebuilt Linux helper pairing on 2026-09-24;
      macOS/Windows installer and native-OS acceptance remain separate gates.
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
- [x] Add `webapp/railway-worker.json` and the `managed:worker` process for
      the separate hosted worker service; live Railway deployment remains an
      external acceptance gate.
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

### Google Meet browser capture + Drive notes (2026-09-24)

- [x] Native Messaging protocol v3 supports explicit `captureSource`, bounded
      48 kHz PCM16 browser chunks, separate mic/speaker channels, and helper
      pipeline persistence before provider calls.
- [x] Chrome/Chromium Meet capture uses an offscreen document, tab capture,
      separate microphone capture, normal-audio playback, cleanup, and a
      popup mode selector; Zoom, Teams, and Slack Huddles remain helper mode.
- [x] Optional BYOK Google Drive OAuth uses `drive.file` in
      `chrome.storage.local`, reuses/creates `My Drive/ai-notetaker`, and
      creates standardized Google Docs with retryable export status.
- [x] Onboarding, popup, Settings, meeting detail, data-handling, protocol,
      and getting-started documentation explain the two capture paths and the
      two-key provider model.
- [ ] Live Google Meet permission/audio proof and real Google OAuth/Drive
      export remain release-owner validation; mocked REST and local protocol
      tests are green.

### In-Meet notes widget (2026-09-24, sub-project 1)

Spec: `docs/superpowers/specs/2026-09-24-meet-widget-design.md`.

- [x] Floating shadow-DOM widget on Meet call pages: one-click start/stop,
      Recording pill with elapsed time, live transcript with Jump to latest,
      flagged moments with optional notes, draggable and position-remembering,
      helper/setup/consent states, "notes ready" card, Settings toggle.
- [x] `Alt+Shift+R` toggles recording and `Alt+Shift+B` flags a moment; both
      ignore non-Meet tabs.
- [x] Fixed Meet capture: the tab stream id is now requested in the service
      worker (offscreen pages have no `chrome.tabCapture`), and microphone
      permission has a one-time grant page plus a pre-check.
- [x] Toolbar starts discover the active Google Meet tab automatically while
      content-script starts remain pinned to their own tab.
- [x] Bookmarks stored on the meeting, shown in the meeting view with jump to
      transcript, and included in Markdown/text exports and the Drive doc.
- [x] Real-browser proof (real Chromium + real helper + local stand-in for
      meet.google.com): capture refusal without invocation, real `Alt+Shift+R`
      start, separate mic/speaker files, bookmark, stop, second start without a
      new invocation, strict CSP + Trusted Types, alarm + notification.
- [ ] Live proof on a real Google Meet call with real participants: widget
      placement against Meet's layout and real audio end to end.
- [ ] Click-through of a real desktop notification (needs a person).
- [x] Calendar reminder (opt-out setting) and calendar-named call in the widget.
- [x] Flagged moments passed to the summarizer (`stop_recording.flaggedMoments`,
      backward compatible) and stored with the meeting.
- [x] Chrome leaves suggested shortcuts unassigned in a fresh profile; the
      widget and Settings read and adapt to the real bindings.
- [x] Helper: with a failing or slow transcription provider, browser and
      desktop audio frames are persisted before entering a per-meeting
      provider queue; stopping drains that queue before finalization. The
      split is covered by core regression tests, while live provider latency
      remains a provider acceptance gate.
- [x] Helper: after a reinstall or new Chrome profile, a missing browser token
      triggers a fresh Native Messaging pairing; a stale non-empty token is
      cleared by the extension before retrying. A real reinstall remains an
      OS/package acceptance gate.
- [ ] Sub-project 2 (smarter notes: structured summaries, chat with a meeting)
      and sub-project 3 (Slack webhook, Notion, email recap).

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
      to off (default under review, see Pre-launch decisions).
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
      + PKCE, with a user-supplied OAuth client today (avoids Google's consent-
      screen verification requirement; a project-owned client is under
      consideration, see Pre-launch decisions). Best-effort: any failure
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

## Sub-project 5: Polish / extras (numbering kept; sub-project 4, mobile capture, is now under Ideas)

- [x] Custom vocabulary support (bounded terms persisted in settings and sent
      to the helper prompt)
- [x] Richer summarization templates (meeting modes plus bounded custom
      instructions for sales calls, standups, 1:1s, interviews, and custom
      templates)
- [x] Cross-browser ports (experimental only; non-Chrome browser ports are out
      of scope for now per `CLAUDE.md`, so Edge/Brave/Firefox are unsupported
      and Firefox is a temporary-add-on experiment) — Edge/Brave: helper now registers its Native
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
      project-operated server. In local mode the provider calls and the optional
      user-owned webapp remain the only outbound application paths; the managed
      service is an explicit opt-in (Hosted sign-in) and not telemetry.
- [x] `docs/data-handling.md` documents storage locations, outbound paths,
      and deletion behavior

### Legal

- [x] Consent-to-record disclosure text reviewed for the desktop/extension
      surface — now explicitly names one-party vs. two-party consent and
      states it is general information, not legal advice
      (`extension/src/onboarding/onboarding.ts`). Not a substitute for an
      actual attorney review.
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
- [x] Follow-up extension polish pass (2026-09-24): removed a duplicate popup
      live-region ID, added consistent focus and dark-mode form styling, made
      onboarding progress screen-reader discoverable, and hardened narrow
      meeting/action-item layouts. Focused extension gates pass; live Chrome,
      helper, provider, and OS audio proof remain separate release-owner work.
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

## Ideas (out of scope for now)

These are not on the roadmap. `CLAUDE.md` lists mobile capture, cellular/PSTN
interception, DRM/protected audio, and non-Chrome browser ports as out of
scope. They are kept here only so the thinking is not lost; do not schedule
them without changing `CLAUDE.md` and the design spec first.

- Mobile capture. Cellular call recording is blocked by OS and store policy on
  both platforms, so any future scope would be limited to:
  - an Android app using `AudioPlaybackCapture`/`MediaProjection` to capture
    Zoom/Meet/Teams mobile app audio;
  - an iOS app using a manual ReplayKit "record, then join your meeting" flow
    (not passive or background);
  - a sync design (mobile has no same-machine helper, so it would need its own
    design pass), and consent-law disclosure surfaced on mobile.
- Supported Firefox, Edge, or Brave builds, including Mozilla AMO signing and
  Edge Add-ons listings.
- Cellular/PSTN call interception and DRM/protected audio: not promised.

## Pre-production audit (2026-09-25) — deferred items

Meet automation settings (2026-09-25), all in Settings → Shortcuts and Meet
widget, all off by default except open-notes:

- [x] Auto-record on joining a Google Meet call (`autoRecordOnMeetJoin`, off).
      A tab landing on a call URL attempts a silent start; Chrome's invocation
      gate on a first join saves the intent so the first toolbar click starts
      recording on that single click. URL-based join detection only, one
      attempt per call, re-armed when a tab joins a different call.
- [x] One-tap attendee disclosure notice (`meetDisclosureNotice`, off): while
      recording, the widget shows a Copy button with a short chat-ready
      notice. The user pastes and sends it themselves — Meet's DOM is never
      scraped or driven. Added the `clipboardWrite` permission.
- [x] Auto-share notes with attendees (`autoShareNotesWithAttendees`, off,
      Hosted AI only): after notes complete, the extension creates an
      expiring share link via a new authenticated workspace-scoped
      `POST /api/v1/meetings/{id}/share` route and shows it on the notes
      page. Nobody receives the link unless the user sends it.
- [x] Open notes when ready (`openNotesWhenReady`, ON): the notes tab opens
      automatically when notes complete (Meet and desktop paths); the
      notification is skipped in that mode and remains the off-mode fallback.
- [ ] Live browser-side transcription during Meet calls: the widget already
      shows the live transcript when the desktop helper streams it, but
      extension-owned Meet capture still transcribes only after stop. In-call
      streaming Deepgram for the browser path remains open work.

Fixed in this pass (see commits ca6aea1 helper, 1e9a3fa extension, 9abc589
webapp): pairing hardening + tray re-pair flow, IPC subscriber-leak pruning,
StopRecording/stop-pipeline non-blocking, retry-worker cap + backoff,
cross-tenant upsertMeeting TOCTOU, checkout double-billing mutex, cookie
Secure flag, managed Meet upload streaming (~700MB → bounded), recording_stopped
listener, Meet capture state persistence + tab-close finalization, Gemini
query-param key leak, recover even-byte clamp, empty-summary retry.

Consciously deferred (why):

- [ ] Extension `listMeetings` search loads full meeting records (summaries
      included) to match a query, while popup/history only needs the list
      view. Fixing this means splitting transcripts/summaries into separate
      storage keys or adding a lightweight index — a storage schema
      migration with a data-move path, too risky to land pre-launch.
      Revisit with the planned history indexing work.
- [ ] Webapp Dockerfile keeps `prisma` CLI in production dependencies:
      `scripts/docker-entrypoint.mjs` runs `npx prisma migrate deploy` at
      container start, so the CLI must ship. Revisit only if entrypoint
      switches to a build-time migration step or a standalone engine.
- [ ] Helper `stop_capture_only` (pipeline.rs) drops mic/speaker streaming
      sessions without `close()` — audit lead from the delegation sweep,
      not re-verified against the current code after the pipeline rework;
      sessions drop when the process exits, but an explicit close would
      flush provider buffers cleanly. Verify on the next pipeline pass.

---

## How to use this file

- Pick items top-down within sub-project 1 before touching later
  sub-projects — the roadmap order in the spec is deliberate (each one
  depends on the one before it working).
- When a section's items are all checked, do a design + guardrails review
  pass before calling that sub-project done, not just at the very end.
- If scope changes (a gap turns out bigger or smaller than expected),
  update the current design spec
  (`docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`)
  first, then reflect the change here.
