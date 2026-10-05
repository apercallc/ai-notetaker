# Release and production acceptance

Updated 2026-10-05. Keep repository/CI evidence separate from install,
provider, account, and physical-device acceptance. The current public release
is v0.18.11. This does not inherit older app acceptance or prove real audio
capture.

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
- [x] GitHub Release [`v0.18.8`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.8)
      was published on 2026-10-05. Release workflow
      [37284514728](https://github.com/apercallc/ai-notetaker/actions/runs/37284514728)
      passed metadata validation, webapp image and extension builds, all four
      native builds, asset/checksum verification, and publication. Docker Hub
      mirroring and Chrome Web Store upload were skipped.
- [x] GitHub Release [`v0.18.9`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.9)
      was published on 2026-10-05. Release workflow
      [37290690554](https://github.com/apercallc/ai-notetaker/actions/runs/37290690554)
      passed metadata validation, webapp and extension builds, all four native
      builds, asset/checksum verification, and publication. Docker Hub
      mirroring and Chrome Web Store upload were skipped.
- [x] GitHub Release [`v0.18.10`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.10)
      was published on 2026-10-05. Release workflow
      [37294935146](https://github.com/apercallc/ai-notetaker/actions/runs/37294935146)
      passed metadata validation, webapp and extension builds, all four native
      builds, asset/checksum verification, and publication. Docker Hub
      mirroring and Chrome Web Store upload were skipped.
- [x] GitHub Release [`v0.18.11`](https://github.com/apercallc/ai-notetaker/releases/tag/v0.18.11)
      was published on 2026-10-05. Release workflow
      [37304453318](https://github.com/apercallc/ai-notetaker/actions/runs/37304453318)
      passed metadata validation, webapp and extension builds, all four native
      builds, and publication. Docker Hub mirroring and Chrome Web Store upload
      were skipped. This does not prove install or recording acceptance.
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

### Repository governance

- [x] Protect `main` from force-push and deletion with the active GitHub
      `Protect main history` ruleset (ID `24497715`).
- [x] Give the extension and webapp CI jobs unique check names in merged
      [PR #40](https://github.com/apercallc/ai-notetaker/pull/40), so their
      required-check contexts can be selected without colliding with other
      workflow jobs.
- [ ] Require pull requests, reviews, and passing CI checks before merging to
      `main`. This is not enabled: the release workflow currently pushes version
      bumps directly to `main`, and GitHub rejected the attempted Actions
      integration bypass actor. Resolve the release-bot path before enforcing
      PR-only updates. Organization-level rules remain unverified because the
      current token cannot inspect them.

### Native desktop install and capture

- [x] macOS arm64 on an Apple M4 with macOS 27.0.1: published DMG checksum
      verified, guided installer completed, installed bundle signature
      verified, and v0.18.2 opened to its first-run screen. Record, Settings,
      and Notes navigation worked; the empty library rendered and Start
      recording correctly remained disabled without provider keys and system
      audio access.
      Chrome and Edge Native Messaging manifests point to the installed host
      and allow the published extension ID.
- [x] On 2026-10-05, verified the v0.18.8 arm64 installer DMG against the
      release `SHA256SUMS`, replaced the installed v0.18.2 app, verified the
      installed bundle with `codesign --verify --deep --strict`, launched it,
      and confirmed the v0.18.8 first-run UI rendered. Chrome and Edge host
      manifests point to the installed app and allow the published extension
      ID. This is install/update proof only; no recording or browser connection
      was exercised.
- [x] On 2026-10-05, verified the public v0.18.9 arm64 DMG against its
      official `SHA256SUMS`; its mounted app bundle passed strict code-signature
      verification and reported version 0.18.9. The installed v0.18.9 copy
      built from that tag's workflow artifact opened to its first-run UI.
      Provider keys, audio permission, recording, and browser connection were
      not exercised.
- [x] On 2026-10-05, verified the public v0.18.10 arm64 DMG against its
      official `SHA256SUMS`; its mounted app bundle passed strict signature
      integrity verification and reported version 0.18.10. This is not
      Developer ID/notarization or install proof. No provider keys, audio
      permission, recording, or browser connection were exercised.
- [x] On 2026-10-05, verified the public v0.18.11 arm64 DMG SHA-256 against
      both the release `SHA256SUMS` file and GitHub's published asset digest.
      The mounted app reports version 0.18.11 and passes strict bundle signature
      integrity verification. The signature is ad hoc with no Team ID; this is
      not Developer ID signing or notarization. No install or launch was tried.
- [ ] Open the v0.18.11 first-run UI and finish macOS arm64 uninstall checks;
      install and verify macOS x86_64,
      Windows x64, and Debian/Ubuntu x64 builds. Native Messaging manifest
      inspection does not prove a browser-to-host connection.
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
      permissions, screenshots, extension ID, and Native Messaging origin.
      Store upload jobs through `v0.18.11` were skipped; manual ZIP
      installation remains available. The published extension ID is absent
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
