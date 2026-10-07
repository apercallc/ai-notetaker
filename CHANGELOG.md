# Changelog

All notable changes to AI Notetaker are documented here.

## Unreleased

- Desktop app: hosted sign-in. Settings → Processing lets you sign in to Hosted AI
  (no provider keys) or keep your own keys, the same on macOS, Windows, and Linux.
  The session token lives in the OS credential store; the password is never stored.
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
