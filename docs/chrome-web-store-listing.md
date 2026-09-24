# Chrome Web Store listing draft

This document is the submission-ready copy and permission justification for
the extension. Store submission, screenshots, publisher verification, and
review remain release-owner actions.

## Short description

Local-first AI meeting notes with live transcripts and action items, powered by
your own desktop helper and provider keys.

## Full description

AI Notetaker records separate microphone and meeting-audio channels without a
meeting bot. Google Meet uses Chrome tab capture; Zoom, Teams, Slack, and
other desktop calls can use the native helper. The free local BYOK mode keeps
audio and meeting history on your machine and uses keys you provide. An
optional Hosted AI mode lets users sign in to a managed service that performs
provider calls, usage metering, and paid-plan billing without exposing
provider keys to the extension.

The extension owns Google Meet capture and communicates with the desktop
helper through Chrome Native Messaging for desktop-call capture. The optional
self-hosted history webapp remains available; Hosted AI is a separate managed
deployment path and is not required for local BYOK recording.

Use the extension only after obtaining the consent required in your location
and by your meeting participants.

## Permission justification

| Permission | Why it is requested |
| --- | --- |
| `storage` | Store provider keys, helper pairing state, settings, and local meeting records in `chrome.storage.local`. |
| `nativeMessaging` | Send desktop-call recording controls and receive transcripts from the user-installed desktop helper. |
| `alarms` | Schedule bounded background retry/sync work when the MV3 service worker is inactive. |
| `tabCapture`, `offscreen` | Capture the active Google Meet tab in an offscreen document without a bot joining the call. |
| Meet/provider host permissions | Capture Google Meet and, in local BYOK mode, send audio to the provider domains selected by the user. Hosted mode requests its service origin only after explicit sign-in. |

The extension creates extension-owned tabs for setup and meeting details using
the tabs API without requesting broad browsing-history permissions. It does not
open a TCP or localhost WebSocket service. Provider keys are kept in protected
local extension storage for BYOK mode; managed provider secrets remain on the
hosted service.

## Submission checklist

- [ ] Confirm the final manifest permissions and privacy disclosure in the
      Chrome Web Store dashboard.
- [ ] Upload the final extension ZIP and screenshots from a real Chrome install.
- [ ] Test the published extension ID against the signed helper's allowlist.
- [ ] Complete store review and record the published version in `CHANGELOG.md`.
