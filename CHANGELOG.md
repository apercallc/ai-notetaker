# Changelog

All notable changes to AI Notetaker are documented here.

## 0.21.1 - 2026-10-08

### Desktop app
- **One place for your account and sync.** Settings no longer has a separate "Web app sync"
  section with a URL and token to paste. Signing in under Account & sync already connects your
  notes; sync status, Sync now and conflict review now live there too. Anyone who set up a pasted
  token keeps syncing.
- "See plans" in Settings opens the in-app Plan page.
- Sync error messages now say what to do (sign out and back in) instead of pointing at the removed
  token screen.
- Removed the unused hosted-processing code. Notes are still made on your device with your own
  keys; recordings left over from older versions are still released to local on startup.

### Web app
- Settings → Integrations no longer offers a desktop sync token; the desktop app gets its own
  when you sign in. The token form now defaults to the read-only token for AI assistants.
- Removed the unused `POST /api/v1/ask` endpoint (nothing called it).

## 0.21.0 - 2026-10-07

### Product
- **New plans.** The desktop app is free with your own AI provider keys and needs no account. A
  free account lets you sign in and manage your devices and data. **Pro** adds cloud sync of your
  notes across devices; **Team** adds a shared workspace (invitations, activity log, retention).
  There is no self-hosted backend: "self-hosted" means bring your own keys.
- **Your notes are never held hostage.** When a plan ends, a payment fails or a workspace is
  downgraded, nothing is deleted or locked. Notes already in the account stay readable, searchable,
  exportable and deletable (the library is read-only), downloads to the desktop app keep working,
  and notes made on your computer wait and upload when a plan returns. Automatic deletion
  policies only run while a Team plan is active.
- Hosted AI (project-run transcription, summaries, import, Ask your notes) is off by default
  (`HOSTED_AI_ENABLED`). Notes are made on your device with your own keys.

### Desktop app
- Updates install in place on macOS and Windows (signed with the project's update key); the
  Linux `.deb` opens the release page.
- Signing in with a free account no longer claims sync is on: the app shows "Needs plan" with a
  plans button, keeps your notes queued, and backs off instead of retrying every minute.
- Sign in with any account, including Google-only ones, using the one-time code from the web
  app's "Connect the desktop app" page (this was blocked by the server before this release).
- New tray icons use the app's brand mark, with a red badge while recording and an amber badge
  when a recovered recording needs attention. A missing tray host on GNOME no longer hides the
  app with no way back.
- Recordings left waiting on hosted processing are recovered with your own keys.
- Fixed "Open account / web library" buttons that did nothing; first-run now opens the API keys
  section; billing pages open only on Stripe or the service itself.
- Fixed a startup crash ("No rustls crypto provider") that left a hidden process running so the
  app never appeared; relaunching now always raises the window.

### Web app
- Pricing, FAQ, privacy, terms and onboarding rewritten for the plans above.
- Team features (invitations, retention, activity log) need the Team plan; read-only notice and
  "your notes are safe" panel when a plan has ended.
- A paid Stripe subscription whose price is not a configured plan now alerts an operator.

### Extension
- Clearer recorder-only wording, and a "Get the desktop app" link in the popup and onboarding.

### Earlier in this cycle
- Fixed the Settings page failing to render since v0.20.0 (sync field templates
  were undefined).
- Fixed a helper crash ("No rustls crypto provider is configured") from the
  update check and managed-audio upload bypassing the shared HTTP client.
- Window lifecycle now matches on every OS: relaunching raises the running
  window, closing hides it to the tray (quits only when no tray exists and nothing
  is recording), launch-at-login starts hidden, and the tray has "Open AI Notetaker".
- Linux launcher entry now has categories and a description; Windows-only
  resources are no longer packaged on other systems; the Windows installer no
  longer shows blocking errors for the optional browser-extension link.
- Audio setup: a platform-appropriate "open settings" button on every OS and
  accurate Windows guidance when only the microphone is missing.
- Desktop UI uses the exact brand mark; added About & legal links.
- README, getting started, the website and the privacy/terms text now describe a
  desktop-first product, the daily GitHub update check, and desktop sign-in.
- Removed hosted Google Calendar access. The hosted service now requests only
  non-sensitive Google scopes (`openid`, `email`, `drive.file`), so it needs no
  sensitive-scope review. The extension's optional local-mode calendar
  (your own OAuth client) is unchanged.
- Added "Continue with Google" sign-in and sign-up (identity scopes only).
  Only verified Google emails are accepted, unconfirmed and owner-provisioned
  accounts are never linked, and new accounts record terms consent before
  Google opens.
- Fixed hosted checkout for trial workspaces and for customers resubscribing
  after a cancellation, so the paid funnel no longer dead-ends.
- Exhausted plans now return a 402 upgrade prompt and are refused before audio
  is staged; one processing job per upload prevents double charges.
- Added the missing workspace data export download; deleting a workspace now
  cancels its Stripe subscription first.
- Hardened invitations (throttled), Stripe webhook secret rotation, Google
  disconnect (revokes at Google), the worker's default URL on Railway, and the
  health check (verifies the database).
- Rewrote the security policy scope for the hosted service.
- Added the dual-mode capture architecture: botless Google Meet browser
  recording with free local BYOK, optional hosted AI processing with
  workspace-scoped usage and billing, and native desktop-call capture for
  macOS, Windows, and Linux.
- Added Meet-first onboarding and stale-tab migration so desktop helper setup
  appears only after an explicit desktop-capture choice.
- Added local archive search across meeting titles, summaries, transcripts, and
  action items in the extension popup.
- Added Markdown, plain-text, and print/PDF-friendly exports to meeting detail
  views in the extension and optional webapp.
- Added contributor guidance, a code of conduct, issue forms, and a pull
  request checklist.
- Added release-owner validation notes for signed installers, updater keys,
  provider calls, and real meeting capture.
- Rewrote the getting-started guide and README around a Google Meet-first
  quickstart: Meet needs only the Chrome extension (no helper, no audio
  routing), while Zoom, Teams, and Slack are a separate desktop-call section
  that requires the helper. The first-run flow is described as one setup screen
  (AI setup with your own keys or Hosted sign-in, microphone permission, and
  one-line consent), then **Open Google Meet**, start with Alt+Shift+R or the
  toolbar icon, and a **Notes ready** notification that opens the notes page.
- Package-manager install commands are now labeled "when released" and no
  longer imply a public release exists; the WinGet ID is documented
  consistently as `AI.Notetaker`.
- Corrected Linux audio guidance: keep normal output routing; the null sink is
  a fallback only. Edge, Brave, and Firefox are documented as unsupported or
  experimental.
- Added a short glossary of user-facing terms (Start notes / Stop notes, Notes
  style, Use my own API keys (free), Hosted (paid)) and the single red
  recording color shared by the extension, helper tray, and webapp.
- Updated the Chrome Web Store listing draft, the roadmap (pre-launch decisions
  and an Ideas section for out-of-scope work), and the contributor guardrails
  reviewer to match the dual-mode design.
