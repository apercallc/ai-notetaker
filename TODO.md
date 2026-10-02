# AI Notetaker — Production Readiness and Product Migration TODO

## Brand consistency — 2026-10-01

- [x] Make the web app browser-tab icon use the canonical green note-and-waveform mark.
- [x] Use `AI Notetaker` for the extension's full and compact display names.
- [x] Align extension setup, permission, notification, and recovery copy on `AI Notetaker`.
- [x] Update the brand asset generator and design-system guidance so future icon
      generation keeps the website and browser-tab artwork aligned.

## Mac installation repair — 2026-10-01

- [x] Confirm v0.15.0 DMG checksum matches the published asset; its app fails
      bundle signature validation with an unsealed linker-only signature.
- [x] Ad-hoc sign the completed app and nested binaries, verify strictly, and
      package a guided installer in Mac CI and release builds.
- [x] Installer uses the user's Applications folder without admin access,
      approves only this app, connects it to Chrome and opens it; rejects
      tampering, symlinks, unrelated apps and running capture.
- [x] Keep older-release instructions until a guided DMG is actually published.
- [x] Published and verified the guided Mac installer in v0.15.2; its release
      checksum matches and the mounted app passes strict signature validation.
- Pending: clean-machine Finder/Gatekeeper acceptance across supported macOS
      versions. No Developer ID or notarization claim.

## Setup clarity — 2026-10-01

- [x] Onboarding uses the project Hosted AI service automatically, matching Settings;
      signup is available without entering a server URL.
- [x] Download page includes per-OS installation, browser connection, audio check,
      first-recording steps and a release link when direct downloads cannot load.
- [x] Signed-in managed users can return to extension and helper downloads from
      Settings without an onboarding prompt or added navigation tab.
- [x] Homepage links directly to desktop setup; Mac instructions include the
      currently required one-time Native Messaging registration command.
- Verified: 596 extension tests and 762 webapp tests with local Postgres; configured
      coverage floors, strict typechecks, webapp lint and both production builds pass.
      Download page browser-checked at desktop and 375 px; production preview loads
      without console errors. No standalone JS formatter is configured.
- Deferred: Chrome Web Store link awaits the published listing from the owner.
      Native installer execution and real-device audio acceptance remain unverified.

## Infrastructure implementation — 2026-10-01

- [x] Durable provider-attempt accounting independent of customer quota refunds
      and content deletion; atomic global/workspace/trial daily admission.
- [x] Shared daily trial grant ceiling covering email and Google signup.
- [x] Standalone processing runtime with leased cleanup in the existing worker
      by default, optional separate cleaner, global concurrent
      job ceiling and bounded per-process Postgres connection pools.
- [x] Durable upload/retention/object-list cursors and deletion retry records
      surviving meeting/workspace deletion; bounded cleanup concurrency.
- [x] Feature-gated immutable signed private uploads for extension Meet,
      desktop helper and browser imports, with verified stored SHA-256/size.
- [x] Additive migration tests, real SDK signing tests, local worker/cleaner
      execution and an isolated local Postgres backup/restore drill.
- [x] Operator cost-report command, Railway/Docker service configuration and
      [deployment/rollback runbook](docs/launch/infrastructure-rollout.md).

Pilot budgets are configured on the existing web/worker services. Hosted
deployment, migrations, health and source CI are verified in the
[2026-10-01 report](docs/launch/production-verification-2026-10-01.md).
Monitoring destinations, provider invoice/throughput proof and
pricing decisions are tracked in that runbook and below. No extra service,
replica or capacity is required for this rollout.

## Only you can do these (updated 2026-09-30)

Everything below needs your accounts, devices, money or a decision. Each item is also
marked **You** where it sits in this file. Engineering follow-ups that need nothing from
you are listed under "Engineering backlog" and are not started.

- Live acceptance on production: a long real import; an upload end to end with staged-audio
  deletion; Google Meet, Google OAuth/Drive, Stripe, managed worker and storage health.
- Live provider checks: Deepgram/Whisper language and vocabulary parameters; measured cost
  per import, per regeneration and per chat question.
- Real devices: Zoom/Teams/Slack on macOS and Windows, native installers, iOS Safari and
  Android Chrome layout checks.
- Store listing and release: Chrome Web Store listing and real screenshots, replace the
  development extension ID in Native Messaging origins, publish the tagged release, and
  `ai-notetaker-mcp` on npm.
- Signing: Apple Developer ID and notarization secrets; Windows code-signing certificate.
- Decisions: plan pricing/allowances and chat pricing, Deepgram diarization for imports as a
  paid perk, Hosted as the primary onboarding path, helper launch-at-login default.

## Engineering backlog (not started; nothing needed from you)

Moved out of the checklist so that every unchecked box in this file needs you.

- Phase 2, Local BYOK: extension popup and helper "Import file" (Symphonia
      decode, user's ffmpeg for video), saved as `captureSource = "import"`,
      `processingMode = "local_byok"`. Covers self-hosted without managed mode.
- Import extras still open: a per-file language hint, a per-file notes template, and import from a link.
- Templates: sections for local BYOK summaries, a cost ledger for regenerations (regeneration is capped per meeting but not metered in the usage ledger), user-defined templates, and template choice on the live Meet widget's hosted path.
- Speaker-name follow-ups: merge two speakers into one, include names in
      the account data export, and suggest names from the calendar attendees.
- Library: per-person private folders and folder permissions, drag-and-drop and multi-select move, autosave and fuller version history, folder-level retention, and folders in the account data export.
- Integrations: Slack/Notion OAuth installs, per-folder routing, a delivery-log page, more event types.
- MCP: OAuth sign-in instead of pasted tokens, write tools behind explicit scopes, resources/prompts, an Ask-your-notes tool, and binding a token to one workspace (today a read token reaches any workspace its owner belongs to, via `X-Workspace-Id`).
- Multilingual: keep a second-language copy of a summary; right-to-left review.
- Audit log: date filters and search, sign-in events, "who viewed" for shared notes, SIEM export. The page is browser-checked at 375/768/1280 px and design-reviewed (2026-09-30).
- Team admin: SSO.
- Chat: pgvector retrieval once usage data exists; a retention-aware design for chat history (intentionally not persisted today).
- Before broad Hosted AI launch: configure and exercise the implemented
      provider-attempt ledger, global/workspace/trial budgets, trial grant caps,
      standalone worker/cleaner and private direct uploads. See
      [infrastructure rollout](docs/launch/infrastructure-rollout.md). Full
      invoice reconciliation, alert delivery and revenue/cohort contribution
      dashboards remain engineering follow-ups; live budgets, CORS and restore
      proof need the deployment accounts. Pricing/allowances remain a decision.
- Dependencies (waiting on upstream): CPAL 0.17+ once macOS 13 support is preserved (CoreAudio releases need macOS 14.2).
- Dependencies (waiting on upstream): webapp TypeScript 7 and ESLint 10 once `eslint-config-next` supports them; Dependabot ignores only the blocked majors.
- Enable live transcription for Hosted AI only after adding server-owned
      real-time usage reservation/metering and a verified short-lived Deepgram
      token flow; other providers continue to create transcripts after stop.
- Smarter notes follow-ups: an email recap (structured summaries, chat, Slack, Notion and webhooks are built).
- Live browser-side transcription during Meet calls: the widget already
      shows the live transcript when the desktop helper streams it, but
      extension-owned Meet capture still transcribes only after stop. In-call
      streaming Deepgram for the browser path remains open work.
- Extension `listMeetings` search loads full meeting records (summaries
      included) to match a query, while popup/history only needs the list
      view. Fixing this means splitting transcripts/summaries into separate
      storage keys or adding a lightweight index — a storage schema
      migration with a data-move path, too risky to land pre-launch.
      Revisit with the planned history indexing work.
- Webapp Dockerfile keeps `prisma` CLI in production dependencies:
      `scripts/docker-entrypoint.mjs` runs `npx prisma migrate deploy` at
      container start, so the CLI must ship. Revisit only if entrypoint
      switches to a build-time migration step or a standalone engine.
- Helper `stop_capture_only` (pipeline.rs) drops mic/speaker streaming
      sessions without `close()` — audit lead from the delegation sweep,
      not re-verified against the current code after the pipeline rework;
      sessions drop when the process exits, but an explicit close would
      flush provider buffers cleanly. Verify on the next pipeline pass.
- Track six RustSec unmaintained-dependency warnings in the transitive
      Tauri/GTK dependency graph (`proc-macro-error` and the `unic-*` crates).
      The 2026-09-29 `cargo audit` run found zero vulnerable or yanked crates;
      revisit when upstream Tauri dependencies offer supported replacements.

## File import: transcribe and summarize an audio/video file (2026-09-30)

Spec: [`docs/superpowers/specs/2026-09-30-file-import-design.md`](docs/superpowers/specs/2026-09-30-file-import-design.md).

- [x] Phase 1, hosted webapp: `/import` page, cookie-session `/api/import*`
      routes with CSRF checks, sandboxed ffmpeg decode in the managed job,
      full-duration usage metering (reserve, true-up before provider spend,
      refund on failure), `Speaker N` labels, stage progress on the meeting.
      Verified: 533 webapp tests, build, and a real-browser upload (201/201/202,
      1 unit + 75 s reserved, 375 px layout).
- [x] Deploy: migrations applied (26 of 26), `INTEGRATIONS_ENCRYPTION_KEY` set on the
      production `web` service, and `ffmpeg`/`ffprobe` confirmed in the running container
      (the service uses the Dockerfile builder). Done 2026-09-30.
- [ ] **You:** live acceptance: import a long real recording (an hour of mp3 and an
      mp4) on production and check the true-up, provider cost
      (`ProcessingJob.providerCostMicros`) and scratch-disk use.
- [ ] **You (decision):** whether Deepgram diarization for imports becomes a paid-tier perk
      (`MANAGED_IMPORT_TRANSCRIPTION_PROVIDER`) once measured cost is known.
- [x] Design-review pass for `/import` and marketing lines (site, `llms.txt`, pricing FAQ):
      done 2026-09-30; see the browser pass under UX overhaul.

## Notes platform series (2026-09-30)

Order: audit foundation, templates, speakers, library, integrations, MCP,
multilingual, audit viewer. One commit per slice on `feat/notes-platform`.

- [x] Audit-event foundation (`lib/audit.ts`, `AuditEvent`; viewer is the last slice).
- [x] Notes templates: six hosted templates with sections, regenerate (3 per
      meeting), Lecture mode in the extension and helper. Spec:
      [`docs/superpowers/specs/2026-09-30-notes-templates-design.md`](docs/superpowers/specs/2026-09-30-notes-templates-design.md).
- [x] Rename speakers: per-meeting names, click-to-rename in the transcript,
      rewrites summary text and action-item owners, used in exports, shares,
      Drive export, Ask and regenerated notes. Spec:
      [`docs/superpowers/specs/2026-09-30-speaker-names-design.md`](docs/superpowers/specs/2026-09-30-speaker-names-design.md).
- [x] Library, Drive-style: nested folders, notes as `.md` text, text-only editor
      (body only, transcript read-only, undo), Trash with 30-day restore,
      folder-scoped search and Ask, upload `.md`/`.txt`. Spec:
      [`docs/superpowers/specs/2026-09-30-library-design.md`](docs/superpowers/specs/2026-09-30-library-design.md).
- [x] Export and integrations: signed webhooks (Zapier/Make/n8n), Slack, Notion, with
      encrypted secrets, SSRF-hardened sending and retries. Spec:
      [`docs/superpowers/specs/2026-09-30-integrations-design.md`](docs/superpowers/specs/2026-09-30-integrations-design.md).
- [x] MCP server over a user's own notes: read-only `notes_read` tokens, a stateless
      Streamable HTTP endpoint at `/api/mcp` (five read tools) and a stdio bridge
      package in `mcp/`. Spec: [`docs/superpowers/specs/2026-09-30-mcp-design.md`](docs/superpowers/specs/2026-09-30-mcp-design.md).
- [ ] **You:** publish `ai-notetaker-mcp` (the `mcp/` package) to npm; it needs your npm account.
- [x] Multilingual: custom vocabulary, spoken-language hint/detection, summary language
      (workspace default and per regenerate). Spec:
      [`docs/superpowers/specs/2026-09-30-multilingual-design.md`](docs/superpowers/specs/2026-09-30-multilingual-design.md).
- [ ] **You:** verify the Deepgram/Whisper language and vocabulary parameters against the live providers (needs provider keys and real audio).
- [x] Audit-log viewer for Team: owner-only page, category/actor filters, keyset paging, CSV
      export. Spec: [`docs/superpowers/specs/2026-09-30-audit-log-design.md`](docs/superpowers/specs/2026-09-30-audit-log-design.md).

## Competitive features, ranked by value over cost (2026-09-30)

- [x] Notes templates (1:1, sales call, standup, interview, lecture) picked per
      meeting, applied to live and imported audio.
- [x] Rename speakers once and apply across transcript and summary.
- [x] Export and integrations: Notion, Slack post, and a webhook / Zapier
      trigger on "notes ready".
- [x] MCP server over a user's own notes (strong open-source differentiator).
- [x] Team library: folders, shared search scope, per-workspace retention.
- [x] Multilingual: auto-detect, translated summary, custom vocabulary.
- [x] Team admin: audit log.

## UX overhaul (2026-09-30)

Spec: [`docs/superpowers/specs/2026-09-30-ux-overhaul-design.md`](docs/superpowers/specs/2026-09-30-ux-overhaul-design.md).

- [x] Webapp: icon nav with phone bottom tab bar, sectioned Settings
      (`/account?tab=`), calmer Team page, date-range filter on Meetings.
- [x] Ask your notes (`/ask`): keyword retrieval inside one workspace, cited
      answers, Hosted Pro/Team only, monthly question cap (`PLAN_CHAT_QUESTION_LIMITS`)
      reserved before provider spend and released on failure.
- [x] Extension popup: live search, paged results, one-click "Browse all meetings".
- [x] Marketing: Ask-your-notes section, plan bullets, FAQ and llms.txt.
- [x] Mobile and tablet pass (2026-10-01): every page audited under phone (390 px) and tablet
      (820 px) touch emulation: no horizontal overflow, 44 px touch targets, 16 px form text (no iOS
      zoom), compact marketing header, phone library with selection bar, action-item rows styled.
      Emulation is not a device: real-device checks stay below.
- [x] Layouts verified in headless Chromium at 375/768/1280 px (no horizontal overflow on 27
      page/width combinations; fixed a tablet header overflow and a phone audit table) and
      design-reviewed, 2026-09-30.
- [ ] **You:** check the layouts on a real iPhone (Safari) and Android (Chrome).
- [ ] **You (decision):** chat pricing from measured per-question cost (no cost ledger for
      chat yet).

## Scale and reliability audit (2026-09-30)

- [x] Prevent concurrent cross-workspace meeting-ID overwrite and upload retry
      cleanup deleting another request's committed audio; Postgres/filesystem
      regressions cover both races.
- [x] Retry failed legacy processing jobs with their replacement packed upload,
      retaining stable processing quota and rejecting meeting-identity conflicts.
- [x] Deduplicate durable Meet audio retries, bound live socket backlog, and
      reject recording starts from a different call tab.
- [x] Pack Hosted Meet frames into deterministic 4 MiB per-channel uploads,
      reducing hourly chunk requests from ~14,400 to ~166 without changing PCM.
- [x] Store helper processing backlog as durable disk ranges and bound streaming
      reconnect backfill instead of retaining full outage audio in memory;
      Stop queues offline gaps durably and defers summary until retries finish.
- [x] Keep meeting error/retry and Drive completion feedback current; fix Meet
      popup routing/captions and stale onboarding provider-key test responses.
- [x] Aggregate quota counters in one query, show audio quota warnings, bound
      cleanup queries/deletion concurrency, continue paginated orphan sweeps,
      and add global worker/expiry database indexes.
- [x] Tie automated releases to the CI-checked commit and atomically push its
      version commit and tag.
- [x] Document unit economics, workload scenarios and staged acceptance gates
      in [the scale and profitability plan](docs/launch/scale-and-profitability.md)
      with a reproducible `scripts/scale-cost-model.mjs`.
- [ ] **You (decision):** new-plan pricing/allowances from measured full-use cost; existing
      commitments remain honored. Direct private uploads and audio transport compression
      still need evaluation with quality and tenant-isolation acceptance.
- [ ] **You:** deploy the new indexes through the normal migration/release flow. Large
      production tables need an online index rollout; no deployment or 100M-user load
      certification is claimed by this local audit.

This tracks the current implementation baseline, the approved dual-mode
product migration, and the remaining production gates. The current target
architecture is
[`docs/superpowers/specs/2026-09-24-dual-mode-product-design.md`](docs/superpowers/specs/2026-09-24-dual-mode-product-design.md);
the 2026-09-21 architecture is historical.

Check items off as they land. If a decision here turns out wrong once
you're building, update the spec doc first, then this file — don't let
them drift apart. Scope is governed by the root `CLAUDE.md`: anything it lists
as out of scope (mobile capture, cellular/PSTN, DRM audio, non-Chrome browser
ports) lives under "Ideas" at the bottom, not in the roadmap.

## Dependency maintenance (2026-09-27)

- [x] Align extension Vitest, coverage, esbuild, jsdom, Chrome types, and
      TypeScript; migrate the WebSocket audio payload for TypeScript 7.
- [x] Migrate the helper's direct `rand` use to 0.10.
- [x] Migrate the webapp's Prisma CLI and client together to 7, including the
      PostgreSQL adapter and patched transitive dependencies.
- [x] Refresh compatible helper, webapp, and release workflow dependencies;
      retain CPAL 0.15 until the macOS 13 compatibility gate is resolved.

## Approved product migration (2026-09-24)

Implementation plan:
[`docs/superpowers/plans/2026-09-24-dual-mode-product-migration.md`](docs/superpowers/plans/2026-09-24-dual-mode-product-migration.md)

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
- [x] Implement managed upload/job APIs, private temporary audio staging, and provider workers.
- [x] Bound hosted Deepgram/Anthropic calls with cancellation, transient retry,
      `Retry-After` handling, and fail-fast permanent provider errors.
- [x] Add a token-protected `/api/v1/jobs/next` worker-polling endpoint with
      database-side single-claim protection for horizontally scaled hosts.
- [x] Keep managed audio in private processing staging only; delete it when a
      job succeeds and expire failed/abandoned staging within 24 hours. R2 and
      S3 backends remain supported; neither is a permanent recording library.
- [x] Implement hosted billing, Stripe retry idempotency, and entitlement enforcement.
- [x] Default managed processing to lower-cost Groq Whisper Large V3 Turbo and
      GPT-6 Luna; keep Deepgram/Anthropic configurable. Groq uses four-minute
      WAV chunks that fit the documented 25 MB free-tier upload cap and labels
      the remote channel generically because Groq does not diarize speakers.
- [x] Create live Stripe products/prices (Hosted Pro $12/mo, capped at 300
      meetings; Hosted Team $39/mo flat per workspace, capped at 2,500) and the
      `/api/v1/billing/webhook` endpoint; set `STRIPE_PRICE_HOSTED_PRO`,
      `STRIPE_PRICE_HOSTED_TEAM`, and `STRIPE_WEBHOOK_SECRET` on the Railway
      `web` service (2026-09-29).
- [x] `STRIPE_SECRET_KEY` is set on Railway `web`; hosted readiness is open
      (`/api/health` reports `managedReady: true`). Verified live 2026-09-30
      with a 100%-off one-time promotion code: Checkout created the Pro
      subscription ($0.00 invoice), the webhook moved the workspace to
      `hosted_pro`/`active`, the Customer Portal opened, and a cancel set
      `cancel_at` to period end. Fixed along the way: promo codes now allowed
      at checkout, and a retry expires an abandoned session instead of a
      one-hour lockout. The portal now has return/privacy/terms URLs, and the
      billing page shows "ends on <date>" for a pending cancellation
      (`cancelsAt`, from Stripe's `cancel_at`). Still open: the key's
      restricted scope is unconfirmed (Railway redacts it; check the Stripe
      dashboard).
- [x] Enforce managed upload checksums and streamed body limits; release failed
      processing reservations so retries do not burn successful-operation quota.
- [x] Purge successful managed audio immediately and reap expired temporary
      upload chunks from the worker heartbeat; failed cleanup remains
      retryable and never silently orphans a private object.
- [x] Implement expiring private meeting-note shares and revocation. Managed
      audio is never exposed through playback, download, or share routes.
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
- [x] Add optional live transcript for extension-owned Meet recordings using
      the user's local Deepgram key: mic and speaker remain separate, and each
      audio chunk is persisted locally before it is sent over the streaming
      connection. Transcript updates are stored locally; provider failure does
      not stop capture.
- [x] Explain the one-click Chrome capture gate accurately in onboarding and
      the in-call widget; if Chrome blocks auto-start, one toolbar click hands
      the pending recording directly to capture without a second Start action.
- [ ] **You:** Complete real Chrome/Meet, provider, deployment, storage, and billing
      acceptance evidence before advertising hosted mode.

## Pre-launch decisions (product audit, 2026-09-24)

Open product and release decisions found by the documentation and product
coherence audit. Each needs an owner decision before public launch; none is
decided yet.

- [ ] **You (decision):** (a) make **Hosted** the primary onboarding call to action (baked-in
      service URL, free trial) with bring-your-own-keys as the secondary option. Needs the
      trial/quota policy from the design spec (section 6) to be affordable first.
- [x] Implement a project-owned **server** Google OAuth client for sign-in and
      Drive export: per-user encrypted-at-rest connections, CSRF state + PKCE
      callback, authenticated extension endpoints, and account
      connect/disconnect controls. Hosted Calendar was removed (v0.8.0), so
      every requested scope (`openid`, `email`, `drive.file`) is non-sensitive:
      no sensitive-scope review, demo video, or user cap. Remaining
      release-owner work is only the Cloud project/client setup and a live
      credential test (`docs/launch/google-oauth.md`); legacy extension BYOK
      setup remains a separate compatibility path until it is explicitly
      removed.
- [x] (c) Move `nativeMessaging`, `identity`, `alarms`, and the five AI provider
      host permissions (Deepgram, Anthropic, Groq, Gemini, DeepSeek) to
      optional permissions requested when the feature is first used, so the
      install prompt for a Meet-only user is minimal. Denials have recovery
      guidance; calendar reminder retries fall back to an in-session timer.
- [ ] **You:** (d) Replace the committed development extension ID in the Native
      Messaging `allowed_origins` with the real Chrome Web Store extension ID
      once the listing exists, and verify the committed manifest `key`
      derives the published ID (or add both origins deliberately).
- [x] (e) Replace the signed Tauri installer updater plan with a daily
      GitHub-release check and explicit opt-in to the release page. The helper
      never downloads or installs updates; a tray action also supports manual
      checks.
- [ ] **You:** (f) Capture real store screenshots on each OS (macOS, Windows, Linux) for
      the Chrome Web Store listing, the install page, and the README; current
      screenshots are rendered extension UI only.
- [ ] **You:** (g) Decide the helper's launch-at-login default (currently off) and have
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
- [ ] **You:** Validate the audio probe and complete meeting workflow on real macOS,
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
      platform-native audio, Tauri tray, Chrome entrypoints, and rendered pages
      remain separate smoke-test concerns rather than being counted as fake
      unit coverage.
- [x] Raise webapp coverage to its CI thresholds (90% statements, functions,
      and lines; 80% branches). On 2026-09-27 the PostgreSQL-backed run passed
      all 306 tests at 90.22% statements, 83.69% branches, 93.72% functions,
      and 93.93% lines; account, Google integration, billing, managed jobs,
      auth-email, session, observability, and managed meeting route paths are
      covered. Remaining per-file coverage gaps are tracked by the CI report.
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
- [ ] **You:** Run real browser/Chrome Native Messaging flows and provider/audio tests
      on supported OSes; source/tests/builds cannot prove a live helper pairing,
      virtual-device routing, or a real provider response. Linux Native
      Messaging and native-loopback audio are now verified on the current host;
      other OSes and live provider responses remain unverified.

## Distribution and installation architecture (2026-09-28)

Current decisions are documented in
[`docs/superpowers/specs/2026-09-28-direct-download-distribution.md`](docs/superpowers/specs/2026-09-28-direct-download-distribution.md).
The 2026-09-21 package-manager and paid-signing plan is historical. The helper
remains native; Docker is for the optional history webapp only.

- [x] Build the install page into a marketing homepage with clear Google Meet
      and desktop-call paths, privacy/AI-mode explanations, and explicitly
      illustrative use-case cards rather than fabricated testimonials.
- [x] Add downloadable SVG infographics for the capture workflow and example
      role-based use cases.
- [x] Expand the public site into a complete product and contributor journey:
      responsive marketing page, explicit pre-launch Hosted AI status, privacy
      notice, terms, SEO/social metadata, SoftwareApplication and FAQ schema,
      sitemap, robots policy, and concise `llms.txt` product facts.
- [x] Remove Homebrew, WinGet, and Chocolatey from release generation and
      end-user setup instructions; update by downloading the newer GitHub
      release artifact.
- [x] Make the release manifest publish checksum-verified unsigned native
      downloads without requiring paid signing or a Chrome Web Store URL.
- [x] Target Apple silicon for the Mac DMG; target Windows x64 and Debian/
      Ubuntu Linux x64, and link the exact artifact from the site manifest.
- [x] Fix the release workflow artifact names so publish-release downloads the
      extension and helper artifacts produced by tagged jobs.
- [x] Add a daily stable-release check to the desktop helper. It asks before
      opening the official GitHub release page and never downloads or installs
      an update; users can also check from the tray menu.
- [ ] **You:** Publish a tagged release and confirm the real Apple-silicon, Windows,
      and Linux artifacts install/register Native Messaging on their target OS.
- [ ] **You:** Publish the Chrome Web Store listing and capture real customer stories
      with written permission before presenting testimonials as social proof.

## Live release gates (audit, 2026-09-27; rechecked 2026-09-29)

- [x] Restore and verify the production API hostname (2026-09-29): Hostinger
      CNAME and Railway ownership TXT records propagated, TLS became valid,
      and `https://ai-notetaker.apercallc.com/api/health` returned `ok:true`.
- [x] Managed-hosting configuration (2026-09-29): `/api/health` returns
      `managedReady:true`. `web` and `managed-worker` have the Groq and OpenAI
      keys (the default pipeline), the shared S3 variables, and worker token;
      `web` has the Stripe secret, webhook secret, and Pro/Team price IDs.
      A live put/get/delete against the Railway bucket
      `ai-notetaker-audio-prod` succeeded with the production credentials. The
      bucket has no server-side lifecycle rule, so the 24-hour expiry of
      abandoned uploads relies on the worker cleanup sweep alone.
- [x] Sentry (2026-09-29): project `ai-notetaker-web` in the `apercallc` org,
      DSN set on `web` and `managed-worker`, plus a 5-minute uptime monitor on
      `/api/health`. Still to do: alert rules that notify a person.
- [x] Outbound email (2026-09-29): `RESEND_API_KEY` and `EMAIL_FROM`
      (`AI Notetaker <noreply@apercallc.com>`) are set on `web`; the
      `apercallc.com` sender domain is verified in Resend and a test message to
      `delivered@resend.dev` was accepted. Production has no silent email
      fallback, so these are required for managed signup and password reset.
      Real inbox delivery (spam placement) is still unverified.
- [ ] **You:** Complete an upload end to end and confirm staged audio deletion on
      success and expiry.
- [ ] **You:** Run cross-platform helper CI on the exact release candidate. The latest
      recorded GitHub helper matrix passed for Linux, macOS, and Windows; repeat
      it against the tagged candidate before publishing native artifacts.
- [ ] **You:** Complete production acceptance with live Chrome/Meet, Google OAuth and
      Drive, providers, managed upload/worker/storage, Stripe billing, and
      health checks after configuration; local tests/builds do not prove those
      account- and deployment-backed flows.
- [ ] **You:** Publish the first unsigned native release and Chrome Web Store listing,
      replace the development extension ID in Native Messaging origins, and
      capture real store screenshots. Rechecked: GitHub has no published
      release and `release/manifest.json` remains unpublished with no artifacts
      or store URL.
- [x] Add `webapp/Dockerfile` and Docker Compose for the optional webapp and
      Postgres, with persistent storage, migrations, health checks, and
      authenticated token setup.
- [x] Keep the release registry Compose file aligned with managed worker,
      provider, billing, and private temporary-storage configuration instead of publishing an
      image that silently runs in an incomplete hosted mode.
- [x] Add helper/extension protocol compatibility and a user-facing install
      health state for helper missing, incompatible, driver missing, routing
      incomplete, and ready.
- [ ] **You:** Complete acceptance testing for native installers, GitHub Release
      download/update flows, and Chrome Web Store/manual extension paths.
- [x] Docker webapp acceptance smoke test passes: image build, migrations,
      health endpoint, unauthenticated rejection, and authenticated API access;
      native OS and remote deployment proof remain release-owner work. The
      current managed stack also verified a running worker and 401 managed
      sign-in for unknown credentials; a separate self-hosted stack verified
      managed sign-in fails closed with HTTP 404.
- [x] Copy the webapp's public assets into the final Docker image after the
      live sign-in check exposed a production logo 404.
- [x] Managed billing route smoke coverage accepts a signed Stripe webhook,
      rejects invalid signatures, and ignores duplicate event delivery against
      disposable Postgres; live webhook delivery was confirmed 2026-09-30.

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
      and quit. The 2026-09-29 brand pass replaces the placeholder app icon
      across extension and desktop icon formats.
- [x] Daily GitHub stable-release check with a native yes/no prompt; users
      download and run the newer installer themselves. See
      `docs/getting-started.md`.
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
- [ ] **You:** "Deploy on Railway" one-click template — `webapp/railway.json` exists
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

- [ ] **You:** End-to-end manual test: real meeting on each of Zoom, Google Meet,
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
- [ ] **You:** Live Google Meet permission/audio proof and real Google OAuth/Drive
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
- [ ] **You:** Live proof on a real Google Meet call with real participants: widget
      placement against Meet's layout and real audio end to end.
- [ ] **You:** Click-through of a real desktop notification (needs a person).
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

---

## Sub-project 2: Cross-platform helper packaging polish

- [ ] **You:** macOS: Apple Developer ID signing + notarization (no "unidentified
      developer" wall on first launch) — `release-build.yml` now signs and
      notarizes automatically once the release owner adds
      `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY`/
      `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` repo secrets; see
      `docs/helper-packaging.md`. Still blocked on the release owner actually
      holding an Apple Developer Program membership.
- [ ] **You:** Windows: Authenticode code signing (no SmartScreen warning wall) —
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
- [x] No Tauri updater signing key or endpoint is needed for the approved
      manual-download update flow.

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
- [x] Use the `notetaker-release` skill for every version bump (standing rule, not a task).
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
widget. Auto-record is on by default (but still requires onboarding and
recording-consent acknowledgement); attendee disclosure and auto-share are off;
open-notes is on:

- [x] Auto-record on joining a Google Meet call (`autoRecordOnMeetJoin`, on).
      A tab landing on a call URL attempts a silent start; Chrome's invocation
      gate on a first join saves the intent so the first toolbar click starts
      recording on that single click. URL-based join detection only, one
      attempt per call, re-armed when a tab joins a different call.
- [x] Chrome's first-use `activeTab` gate now shows a brief, non-error
      "One Chrome step" message in the in-call widget. It tells the user that
      the toolbar click/assigned shortcut starts the pending recording; the
      widget no longer offers a futile retry. Chrome still requires this
      invocation and it cannot be bypassed by an extension.
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

Fixed in this pass (see commits ca6aea1 helper, 1e9a3fa extension, 9abc589
webapp): pairing hardening + tray re-pair flow, IPC subscriber-leak pruning,
StopRecording/stop-pipeline non-blocking, retry-worker cap + backoff,
cross-tenant upsertMeeting TOCTOU, checkout double-billing mutex, cookie
Secure flag, managed Meet upload streaming (~700MB → bounded), recording_stopped
listener, Meet capture state persistence + tab-close finalization, Gemini
query-param key leak, recover even-byte clamp, empty-summary retry.

Consciously deferred (why):


---

## Product design and branding (2026-09-29)

- [x] Establish one product mark and regenerate extension and desktop app
      icons from the canonical local SVG; align the favicon, landing page,
      signed-in app, extension, and sign-in screens.
- [x] Unify primary action color, control sizing, focus feedback, and reduced
      motion behavior across the extension, history app, and marketing site.
- [x] Record design tokens, accessible interaction rules, and the licensed
      local icon approach in `docs/design-system.md`.
- [ ] **You:** Capture and review real browser and native OS screenshots for the
      extension, helper, and history app before store/release publication.

## Final production-readiness audit (2026-09-29)

- [x] Keep Google Meet processing bound to the mode stored when capture starts;
      a Settings change cannot silently send local BYOK audio to Hosted AI or
      process a Hosted AI recording with local keys. Automatic attendee sharing
      also checks the recording's original managed workspace.
- [x] Register Meet capture before the offscreen start acknowledgement so its
      first audio chunks are not discarded.
- [x] Bound public Stripe webhook request bodies to 1 MiB before signature
      verification or JSON parsing.
- [x] Reduce release workflow token permissions to read-only builds, with
      package publishing on the image job and repository write access only on
      the GitHub release publishing job; build checkouts do not persist tokens.
- [x] Keep the Meet widget's keyboard toggle action clear to screen readers and
      retain section links in the mobile site navigation.
- [ ] **You:** Run the full cross-platform, live-provider, signed-in managed service,
      browser install, and native audio acceptance checks; these need real
      accounts/devices and a published release.
- [x] Fix Hosted AI account creation links to select the signup tab and keep
      managed request timeouts active through response-body parsing and retry.
- [x] Bound pending and retained managed audio per workspace under a shared
      database lock; reject chunk retries that exceed declared upload bytes.
- [x] Remove production inline-script CSP permission by using per-request
      nonces; redact client, server, and worker telemetry to safe labels and
      source locations only.
- [x] Require a valid extension install channel and macOS, Windows, and Linux
      artifacts before a release manifest can be marked published.

---

## How to use this file

- Pick items top-down within sub-project 1 before touching later
  sub-projects — the roadmap order in the spec is deliberate (each one
  depends on the one before it working).
- When a section's items are all checked, do a design + guardrails review
  pass before calling that sub-project done, not just at the very end.
- If scope changes (a gap turns out bigger or smaller than expected),
  update the current design spec
  (`docs/superpowers/specs/2026-09-24-dual-mode-product-design.md`)
  first, then reflect the change here.
