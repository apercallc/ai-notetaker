# Chrome Web Store listing draft

This document is the submission-ready copy and permission justification for
the extension. Store submission, screenshots, publisher verification, and
review remain release-owner actions.

## Short description

Local-first AI meeting notes with live transcripts and action items, powered by
your own desktop helper and provider keys.

## Full description

AI Notetaker records separate microphone and meeting-audio channels through a
native desktop helper, shows a live transcript, and creates a summary with
action items. Audio and meeting history stay on your machine by default. You
bring your own transcription and summarization keys; the project has no
account, subscription, analytics, or project-operated backend.

The extension is only the setup and recording UI. It communicates with the
desktop helper through Chrome Native Messaging. The optional history webapp is
self-hosted by the user and is not required to record meetings.

Use the extension only after obtaining the consent required in your location
and by your meeting participants.

## Permission justification

| Permission | Why it is requested |
| --- | --- |
| `storage` | Store provider keys, helper pairing state, settings, and local meeting records in `chrome.storage.local`. |
| `nativeMessaging` | Send recording controls and receive transcripts from the user-installed desktop helper. |
| `alarms` | Schedule bounded background retry/sync work when the MV3 service worker is inactive. |

The extension creates extension-owned tabs for setup and meeting details using
the tabs API without requesting broad browsing-history or host permissions. It
does not call AI provider domains directly and does not open a TCP or localhost
WebSocket service.

## Submission checklist

- [ ] Confirm the final manifest permissions and privacy disclosure in the
      Chrome Web Store dashboard.
- [ ] Upload the final extension ZIP and screenshots from a real Chrome install.
- [ ] Test the published extension ID against the signed helper's allowlist.
- [ ] Complete store review and record the published version in `CHANGELOG.md`.
