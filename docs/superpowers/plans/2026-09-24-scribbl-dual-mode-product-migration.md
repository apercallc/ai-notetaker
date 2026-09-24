# Scribbl-like Dual-Mode Product Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate AI Notetaker to a botless, searchable meeting product with free local BYOK execution and a paid hosted AI execution mode across Google Meet, macOS, Windows, and Linux.

**Architecture:** Keep Native Messaging secure and make capture source and processing mode explicit. Google Meet is an extension-owned browser path with IndexedDB-first chunks and direct local/managed processing; desktop-call Local BYOK continues to call providers from the helper, while managed mode uploads durable local recording chunks to an authenticated multi-tenant service whose workers own provider calls, usage, storage, and billing.

**Tech Stack:** TypeScript/Vitest/Manifest V3, Rust/Tauri/Cargo, Next.js/Prisma/Postgres, object storage, a durable queue/worker runtime, Stripe webhooks, Chrome tab/offscreen capture, macOS ScreenCaptureKit, Windows WASAPI, and PipeWire/PulseAudio adapters.

**Spec:** `docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`

## Global Constraints

- Raw audio is persisted locally before every upload or provider call.
- Native Messaging plus the existing Unix socket/named-pipe relay remains the extension/helper channel; never add an open TCP/localhost control port.
- Mic and system/remote audio remain separate durable streams.
- Local BYOK requires no account; managed mode never exposes platform provider keys to the client.
- Hosted data is workspace-scoped, private by default, deletable, retention-controlled, and served through authenticated routes.
- The committed extension manifest `key` and both helper binaries remain unchanged.
- Cellular/PSTN and DRM/protected audio are outside the product promise.
- Every changed surface gets focused tests plus the relevant release-floor command.

## Review Focus

- Meet tab closes or permission is revoked during capture: preserve the existing channel, surface recovery, and make the meeting retryable.
- Native loopback is missing or denied: report the exact capability gap and never present a false “ready” state.
- Managed upload is retried: idempotency prevents duplicate chunks, duplicate usage charges, and duplicate summaries.
- A workspace changes plan or payment fails during processing: server-side entitlements stop new work without deleting already-owned data.
- A shared meeting link is revoked or expires: it cannot access another meeting, workspace, or provider secret.

---

### Task 1: Replace stale product contracts with the dual-mode spec

**Files:**
- Create: `docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`
- Create: `docs/superpowers/plans/2026-09-24-scribbl-dual-mode-product-migration.md`
- Modify: `CLAUDE.md`
- Modify: `extension/CLAUDE.md`
- Modify: `helper/CLAUDE.md`
- Modify: `webapp/CLAUDE.md`
- Modify: `TODO.md`

**Interfaces:**
- Produces the authoritative `ProcessingMode`, `MeetingCapture`, hosted-service, and migration terminology used by later tasks.

- [x] Write the approved architecture spec and migration plan.
- [x] Replace the old “no hosted backend/no billing” rules with the dual-mode rules while retaining the Native Messaging, local-first, and provider-key boundaries.
- [x] Add a migration banner to the historical 2026-09-21 architecture and the old Meet/Drive plan so future work does not follow superseded assumptions.
- [x] Add explicit current-state versus target-state checkboxes to `TODO.md`.
- [x] Review the docs for claims that imply hosted mode already ships; use “planned” or “migration” until code and deployment proof exist.

### Task 2: Define mode-neutral capture and processing contracts

**Files:**
- Modify: `extension/src/types.ts`
- Modify: `extension/src/lib/storage.ts`
- Modify: `helper/crates/core/src/lib.rs`
- Modify: `helper/crates/core/src/pipeline.rs`
- Modify: `helper/crates/core/src/native_messaging.rs`
- Create: `extension/tests/processingMode.test.ts`
- Create: `helper/crates/core/tests/processing_mode.rs`

**Interfaces:**
- `ProcessingMode = { kind: "local_byok", providerConfig: ... } | { kind: "managed", accountId: string, workspaceId: string, plan: string }`.
- `CaptureSource = "meet_tab" | "desktop_loopback" | "desktop_virtual_device"`.
- `MeetingCapture` stores source, independent channel metadata, consent acknowledgement, and resumable upload/job state.
- Native messages include `capture_capabilities`, `managed_upload_start`, `managed_upload_chunk`, `managed_upload_complete`, and `managed_job_status` with versioned schemas.

- [x] Add compatibility coverage for old local metadata, local BYOK defaults,
      malformed managed identities, oversized browser chunks, and incompatible
      protocol versions; future-version fixtures remain a release follow-up.
- [x] Implement serde/TypeScript normalization without moving secrets into synced extension storage.
- [x] Make local BYOK the backward-compatible default when no managed configuration exists.
- [x] Add safe user-facing recovery categories to protocol error handling;
      older helper envelopes remain compatible because the extension derives a
      category when the optional field is absent.
- [x] Run the focused extension and Rust tests; the current extension suite and Rust workspace are green.

### Task 3: Finish Google Meet botless recording as a first-class source

**Files:**
- Modify: `extension/src/meet/meetCapture.ts`
- Modify: `extension/src/meet/offscreen.ts`
- Modify: `extension/src/meet/session.ts`
- Modify: `extension/src/content/meetWidget.ts`
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/src/lib/backgroundController.ts`
- Test: `extension/tests/meetCapture.test.ts`, `extension/tests/meetSession.test.ts`, `extension/tests/meetWidget.test.ts`

**Interfaces:**
- `MeetCaptureController.start(tabId, meetingId, mode)` and `.stop(meetingId)` produce independent mic/remote chunks and durable state transitions.
- Meet detection exposes `isMeetTab`, `captureReadiness`, and a visible recording/consent state to the popup and in-call widget.

- [x] Add regression coverage for Meet-tab close/navigation cleanup,
      offscreen reuse, and stop-message failure cleanup/error reporting.
- [x] Cover late channel start, offscreen reuse, permission denial, popup
      closure, Native Messaging reconnect, and stop-after-error in the Meet
      capture/session/offscreen/widget suites (29 extension files, 382 tests
      green). Real Chrome permission prompts and a live Meet call remain a
      separate acceptance gate below.
- [x] Implement automatic active Meet-tab discovery for toolbar starts with
      explicit user start/stop and no bot or participant insertion.
- [x] Make Meet first-run start in the browser-owned capture path; missing
      helper UI is suppressed on Meet and the external desktop installer is
      reached only after an explicit desktop capture choice.
- [x] Keep ordinary onboarding links Meet-first; only the explicit desktop-call
      choice opens the native-helper install section.
- [x] Ignore stale public `mode=desktop` flags unless the URL also carries the
      explicit `source=desktop` install intent; internal helper onboarding also
      requires a short-lived session marker created by the desktop action.
- [x] Persist Meet chunks in extension IndexedDB before any provider call or
      upload; direct provider calls are limited to browser-owned Meet BYOK,
      while desktop-call chunks continue through the helper protocol.
- [x] Keep Drive export optional and downstream of completed local meeting state.
- [x] Keep completed Meet notes complete when best-effort IndexedDB audio cleanup
      fails; retained raw chunks remain available for later cleanup.
- [x] Bound browser-owned BYOK provider requests with cancellation, transient
      retry, bounded `Retry-After` handling, and fail-fast permanent errors;
      durable Meet chunks remain available when all attempts fail.
- [x] Run focused tests and the extension typecheck/build.

### Task 4: Add native loopback capability adapters for all desktop OSes

**Files:**
- Modify: `helper/crates/audio/src/macos.rs`
- Modify: `helper/crates/audio/src/windows.rs`
- Modify: `helper/crates/audio/src/linux.rs`
- Modify: `helper/crates/audio/src/lib.rs`
- Modify: `helper/crates/core/src/pipeline.rs`
- Create: `helper/crates/audio/tests/capabilities.rs`
- Modify: `docs/getting-started.md`, `docs/data-handling.md`, `docs/helper-packaging.md`

**Interfaces:**
- `AudioBackend::capabilities() -> CaptureCapabilities` reports native loopback, microphone, permission, sample format, and fallback guidance.
- `AudioBackend::start_capture(request: CaptureRequest) -> CaptureStreams` returns independent mic/system streams and a cleanup handle.

- [x] Add platform-mocked capability matrix tests for missing permissions,
      missing monitor sources, both independent routes, and fail-closed
      readiness without requiring host audio hardware.
- [x] Implement macOS ScreenCaptureKit/native system-audio capture with
      Screen Recording permission metadata and BlackHole fallback guidance.
- [x] Implement Windows WASAPI shared-mode loopback capture with VB-CABLE fallback guidance; the helper now reads the default render endpoint through a real WASAPI capture client and downmixes its float frames to PCM16.
- [x] Implement Linux PipeWire/PulseAudio monitor probing with null-sink fallback guidance.
- [x] Update readiness UI so “all calls” means supported OS-exposed audio, not an unconditional promise.
- [x] Run `cargo fmt --all -- --check`, focused audio tests, and clippy.

### Task 5: Add managed upload and hosted processing contracts

**Files:**
- Modify: `webapp/prisma/schema.prisma`
- Create: `webapp/src/lib/managedJobs.ts`
- Create: `webapp/src/app/api/v1/uploads/route.ts`
- Create: `webapp/src/app/api/v1/uploads/[uploadId]/chunks/[chunkIndex]/route.ts`
- Create: `webapp/src/app/api/v1/meetings/[meetingId]/process/route.ts`
- Create: `webapp/src/app/api/v1/jobs/[jobId]/route.ts`
- Create: `webapp/src/lib/usageLedger.ts`
- Create: `webapp/src/lib/objectStorage.ts`
- Create: tests for each route and service

**Interfaces:**
- `createUpload(workspaceId, meetingId, manifest, idempotencyKey)` returns an upload ID and bounded signed chunk targets.
- `putChunk(uploadId, chunkIndex, checksum, bytes)` is idempotent and workspace-scoped.
- `enqueueManagedProcessing(workspaceId, meetingId, uploadId)` reserves verified entitlement and returns a job ID.
- `getManagedJob(workspaceId, jobId)` never exposes another workspace's status or object key.

- [x] Add Postgres-backed tests for tenant isolation, idempotent upload/chunk
      retries (including concurrent duplicate requests), quota reservation
      under contention, and unauthorized reads.
- [x] Add checksum and hard size-limit route cases; release failed processing
      reservations so provider failures do not consume successful-operation
      quota.
- [x] Add schema migrations for `ManagedUpload`, `UploadChunk`, `ProcessingJob`, `UsageLedgerEntry`, subscriptions, billing events, and private object references.
- [x] Implement authenticated, bounded, resumable uploads without accepting client-reported usage as authoritative.
- [x] Add a token-protected worker polling endpoint for queued jobs and make
      provider execution single-owner across concurrent worker requests.
- [x] Bound hosted Deepgram/Anthropic calls with cancellation, transient retry,
      `Retry-After` handling, and fail-fast permanent provider errors.
- [x] Add a 15-minute worker lease and conditional finalization so a crashed
      hosted worker cannot strand a job in `processing` or overwrite a
      reclaimed attempt.
- [x] Add a 24-hour managed upload-session expiry; expired sessions reject
      further chunks and can be recreated with the same helper idempotency key
      after private chunk objects are cleaned up.
- [x] Reap expired managed upload rows and private chunk objects from the worker
      heartbeat; expiry races cannot resurrect an abandoned upload, and a
      storage-delete failure leaves the expired row retryable instead of
      orphaning the private object.
- [x] Keep existing self-hosted `/api/*` ingestion behavior compatible until the hosted client migration is complete.
- [x] Run `webapp/npm run test:with-postgres`; route-specific isolation,
      concurrent duplicate-chunk, and hosted worker lifecycle tests pass.

### Task 6: Add hosted account, workspace, plans, and billing

**Files:**
- Modify: `webapp/src/lib/auth.ts`, `webapp/src/proxy.ts`
- Modify: `webapp/src/lib/workspaces.ts`
- Create: `webapp/src/lib/billing.ts`
- Create: `webapp/src/app/api/v1/billing/checkout/route.ts`
- Create: `webapp/src/app/api/v1/billing/portal/route.ts`
- Create: `webapp/src/app/api/v1/billing/webhook/route.ts`
- Create: hosted plan/usage UI and tests

**Interfaces:**
- `getEntitlements(workspaceId)` is derived from verified subscription state and usage ledger.
- `createCheckoutSession(workspaceId, priceId)` and `createPortalSession(workspaceId)` require an authenticated owner.
- `claimStripeEvent(eventId)` is transactional and retry-safe.

- [x] Add webhook replay and cancellation state tests.
- [x] Add red tests for owner-only billing actions; member checkout and portal
      attempts are rejected by the route tests.
- [x] Add managed-hosting signup that provisions isolated owner workspaces;
      self-hosted bootstrap remains setup-token protected.
- [x] Gate managed sign-in, billing, entitlements, and worker routes behind
      `MANAGED_HOSTING=true`; self-hosted history deployments expose only the
      legacy owner-controlled sync surface.
- [x] Add a bounded three-day payment-failure grace window tied to the Stripe
      billing period, with fail-closed entitlement tests after expiry.
- [x] Add an owner-controlled managed retention policy; the worker deletes
      expired meetings, transcripts, shares, and private recording objects
      without touching active processing jobs.
- [x] Make Stripe subscription event application ordering-aware and preserve
      the paid plan during payment-failure state; add regression coverage.
- [x] Implement Stripe webhook authority and keep API keys/secrets server-side.
- [x] Propagate workspace metadata into both the Checkout Session and Stripe Subscription so subscription webhooks always resolve the tenant.
- [x] Add clear local BYOK versus managed plan copy and a no-card local path.
- [x] Persist failed-login throttles in Postgres with atomic increments so
      managed authentication remains protected across replicas and deploys.
- [x] Link extension Hosted AI onboarding to the hosted login/signup page so a
      new managed user can create an account without leaving setup at a dead end.
- [x] Add workspace-scoped entitlement preflight before managed recording so
      inactive subscriptions and exhausted usage are surfaced before capture.
- [x] Propagate an explicitly selected managed workspace through extension,
      helper, and API requests, with membership validation and tenant-isolation
      coverage for multi-workspace accounts.
- [x] Persist the original managed account/workspace on durable Meet and
      desktop-helper retries; workspace changes now fail closed rather than
      replaying pending audio into the newly selected tenant.
- [x] Add operator-safe correlation IDs to worker and billing webhook failures
      without returning provider internals or logging recordings/transcripts.
- [x] Restrict managed API CORS to the fixed extension origin (with a
      controlled-fork override) instead of exposing bearer-authenticated
      routes to wildcard browser origins.
- [x] Run webapp lint, typecheck, Postgres tests, and build.

### Task 7: Add managed client mode and unified meeting library

**Files:**
- Create: `extension/src/lib/managedClient.ts`
- Modify: `extension/src/lib/webappSync.ts`
- Modify: `extension/src/lib/storage.ts`
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/src/settings/settings.ts`
- Modify: webapp library/search/share/download pages and API routes
- Create: extension and webapp tests

**Interfaces:**
- `ManagedClient.startUpload(meeting, mode)` returns resumable upload state.
- `ManagedClient.appendChunk(uploadId, channel, index, bytes)` retries safely with idempotency.
- `ManagedClient.watchJob(jobId)` emits processing state and final meeting references.
- `createMeetingShare(workspaceId, meetingId, expiry)` and `revokeMeetingShare(tokenId)` manage private share links.

- [x] Add coverage for managed retry/offline state and expired upload sessions;
      duplicate chunks, session expiry, local/managed mode switching, share
      expiry/revocation, and managed delete-everywhere object cleanup are now
      covered. Expired hosted access now clears only the stale helper job
      cursor while retaining local audio/upload state. A fresh managed sign-in
      now re-drains durable Meet records that failed during the expired
      session, while local-BYOK records remain excluded.
- [x] Implement bounded automatic managed-upload retries with exponential
      backoff plus idempotent chunk writes on top of existing local-first
      storage, including a persisted helper upload ID and next-chunk cursor
      that resumes after restart. Extension-owned Meet records marked
      `processing` now also resume after an MV3 worker suspension when Hosted
      AI remains active; serialized outbox draining also retries managed error
      records after a new hosted session is saved.
- [x] Keep library search over title, transcript, action items, and meeting date behind workspace authorization.
- [x] Add private share-link creation/revocation, read-only shared meeting pages, separate managed mic/speaker WAV downloads, and preserve the existing Google Drive formatter.
- [x] Run extension and webapp focused tests/builds.

### Task 8: Release, migration, and real acceptance gates

**Files:**
- Modify: `README.md`, `extension/README.md`, `helper/README.md`, `site/index.html`
- Modify: `docs/testing.md`, `docs/code-signing-policy.md`, `release/README.md`
- Modify: `TODO.md`, `CHANGELOG.md`
- Add: hosted deployment/runbook and per-OS acceptance checklist

- [x] Remove stale claims that the project can never host a service; clearly separate current release capability from target hosted capability.
- [x] Test local BYOK with mocked providers and managed mode against the
      disposable hosted stack. Managed mode has a Postgres-backed
      mocked-provider success test, and the stack now ships a first-party
      managed worker profile with authenticated polling/backoff coverage;
      real provider calls remain a separate acceptance gate.
- [x] Exercise the managed billing HTTP boundary with a signed Stripe webhook,
      duplicate-event replay, and invalid-signature rejection against
      disposable Postgres; live Stripe test-mode delivery remains separate.
- [x] Build and start the disposable Docker hosted stack, apply all migrations,
      verify the container healthcheck, worker-token rejection, and an
      authenticated idle worker poll; live provider and billing calls remain
      separate release gates.
- [x] Add a first-party `railway-worker.json` and `managed:worker` process so
      Railway hosted deployments cannot accidentally run the webapp without a
      worker that drains managed jobs.
- [x] Add a non-secret managed-readiness contract to `/api/health`; managed
      deployments now distinguish a live process from a service configured
      with worker, provider, Stripe, and application-URL credentials.
- [ ] Run real Google Meet capture in Chrome and real helper Native Messaging on a supported device.
- [ ] Run physical macOS, Windows, and Linux loopback/microphone checks and record results separately from unit tests. The current Linux host passed the real helper/Native Messaging protocol-v3 check and PipeWire/PulseAudio probe on 2026-09-24; macOS and Windows remain open.
- [ ] Verify deployment health, migrations, object-storage deletion, Stripe test webhooks, and provider calls before calling hosted mode released.
- [x] Run the required release-floor commands for helper, extension, and webapp.

## Execution order

Tasks 1–4 establish the client and capture contract. Tasks 5–6 establish the
server and billing boundary. Task 7 connects them, and Task 8 is the release
gate. Do not advertise managed mode as available until Tasks 5–8 have real
deployment and provider evidence; local BYOK and Meet capture can ship
independently when their own gates pass.
