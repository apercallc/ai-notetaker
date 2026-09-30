# Changelog

All notable changes to AI Notetaker are documented here.

## Unreleased

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
