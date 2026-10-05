# Release and production acceptance

Updated 2026-10-05. Keep repository/CI evidence separate from install,
provider, account, and physical-device acceptance. The installed Mac app was
still v0.18.2 during this review; the newer v0.18.7 release has build and
publication proof but does not inherit the older app's device acceptance.

## Verified release evidence

- [x] GitHub Release [`v0.18.2`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.2)
      is published with macOS arm64 and x86_64 DMGs, Windows x64 installer,
      Debian package, extension ZIPs, generated release manifest, and checksums.
- [x] GitHub Release [`v0.18.6`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.6)
      was published on 2026-10-05. Its release workflow passed metadata
      validation, webapp image and extension builds, native builds for all four
      targets, package verification, and GitHub Release publication. Docker Hub
      mirroring and Chrome Web Store upload were skipped.
- [x] GitHub Release [`v0.18.7`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.7)
      was published on 2026-10-05. Release workflow
      [37281422274](https://github.com/apercallc/ai-notetaker/actions/runs/37281422274)
      passed metadata validation, webapp image and extension builds, all four
      native builds, asset/checksum verification, and publication. Docker Hub
      mirroring and Chrome Web Store upload were skipped.
- [x] Release workflow [37254643304](https://github.com/apercallc/ai-notetaker/actions/runs/37254643304)
      passed release metadata validation, package builds, cross-platform helper
      jobs, asset verification, and GitHub Release publication.
- [x] Production `/api/health` returned HTTP 200 with `managedReady: true` on
      2026-10-04 after the `v0.18.2` release. This confirms service readiness
      checks, not an end-to-end customer journey.
- [x] Live `/api/health` check on 2026-10-05 returned `ok: true`,
      `managedReady: true`, and `objectStorage: "s3"`. This still does not prove
      signup, provider processing, billing, or cleanup end to end.
- [x] Railway production was verified on 2026-09-30 with web and
      managed-worker deployed from release commit `2922289`; both had one
      running replica, Postgres was online, and the environment had no pending
      changes, active warnings, or recent failed/crashed deployments. This is a
      dated snapshot; the 2026-10-05 health check above does not inspect Railway
      deployment status.
- [x] Stripe checkout, webhook, and portal cancellation were exercised on
      2026-09-30 with a 100%-off test promotion; recheck paid billing before
      changing pricing or billing configuration.

The checked-in [`release/manifest.json`](../../release/manifest.json) is an
input template and intentionally stays `unpublished` with no artifact list.
The tagged build generates the published manifest from the actual files and
checksums. Release binaries are unsigned; SHA-256 checks detect corruption but
do not authenticate the publisher. See the [unsigned install guide](../unsigned-install.md).

## Still required before broad public promotion

### Native desktop install and capture

- [x] macOS arm64 on an Apple M4 with macOS 27.0.1: published DMG checksum
      verified, guided installer completed, installed bundle signature
      verified, and v0.18.2 opened to its first-run screen. Record, Settings,
      and Notes navigation worked; the empty library rendered and Start
      recording correctly remained disabled without provider keys and system
      audio access.
      Chrome and Edge Native Messaging manifests point to the installed host
      and allow the published extension ID.
- [ ] Finish macOS arm64 update/uninstall checks; install and verify macOS
      x86_64, Windows x64, and Debian/Ubuntu x64 builds. Native Messaging
      manifest inspection does not prove a browser-to-host connection.
- [ ] On each OS, make a real meeting call and verify separate microphone and
      speaker tracks, visible recording state, stop/finalize, provider failure
      recovery, and restart recovery of an interrupted recording.
      On the tested Mac, system-audio capture remains unavailable until the
      user grants macOS Screen & System Audio Recording access or installs
      BlackHole; no permission was granted and no capture was attempted.
- [ ] Verify a fresh user can configure a local provider key in the OS vault,
      test it, record, and open the local note without an AI Notetaker account.
      Do not use a test key to claim provider quality or paid-path acceptance.

### Browser extension and migration

- [ ] In installed Chrome, verify Meet capture with real participants and
      Teams/Zoom browser-tab capture, including navigation, tab close, export,
      and import into desktop.
- [ ] Complete a real `.ntarchive` export/import and confirm extension source
      records remain intact and imported audio stays on separate tracks.
- [ ] Publish the Chrome Web Store listing and verify store installation,
      permissions, screenshots, extension ID, and Native Messaging origin. The
      `v0.18.2`, `v0.18.6`, and `v0.18.7` store upload jobs were skipped; manual
      ZIP installation remains available. The published extension ID is absent
      from this Mac's Chrome Default profile, so the registered host has not
      been exercised through Chrome.

### Managed service and operations

- [ ] Run one real managed upload through job completion; verify temporary
      audio deletion after success and expiration cleanup after an abandoned
      upload.
- [ ] Complete production signup, password reset, login, Google sign-in/Drive,
      provider processing, and billing with owner-controlled accounts.
- [ ] Confirm signup and password-reset messages arrive in Gmail and Outlook,
      including spam placement and SPF/DKIM/DMARC alignment.
- [ ] Configure Sentry alerts that notify an operator, then send a test event
      and verify receipt. The uptime monitor alone is not alert-routing proof.
- [ ] Confirm the production Stripe key has the intended restricted
      permissions in the Stripe dashboard.

## Optional and deferred

- Docker Hub mirroring is optional; the release job skips it when mirror
  credentials are absent. The GitHub Container Registry image is the primary
  published container path.
- Automatic extension-to-desktop audio handoff, synchronized settings, and
  extension access to workspace notes remain future migration work. The manual
  archive path stays supported until automatic handoff passes acceptance.
- Hosted live transcription remains off until server-side metering and the
  managed token flow are ready. Local BYOK and desktop capture do not depend on
  it.
