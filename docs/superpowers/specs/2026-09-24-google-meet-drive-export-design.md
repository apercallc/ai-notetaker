# Google Meet Browser Capture and Google Drive Export

## Goal

Make Google Meet the low-friction browser path while keeping Slack Huddles,
Zoom, and Microsoft Teams on the desktop-helper path. After a meeting is
summarized, optionally create a readable Google Doc in `My Drive/ai-notetaker`
without changing the local-first or BYOK architecture.

## Decisions

1. The extension may capture Google Meet media, but it never calls an AI
   provider. A long-lived offscreen document owns `tabCapture` and microphone
   streams; the helper remains the owner of raw-audio persistence,
   transcription, summarization, retries, and crash recovery.
2. Meet sends two independent PCM16 streams over the already authenticated
   Native Messaging port: microphone and remote meeting audio. Chunks are
   bounded below the 1 MiB Chrome Native Messaging limit and are rejected by
   both endpoints when oversized or malformed.
3. `start_recording` gains an explicit `captureSource` (`desktop` or `meet`).
   Desktop remains the default and keeps cpal/parec capture unchanged. Meet
   starts the same helper pipeline without opening an OS capture device, then
   accepts browser chunks until stop.
4. Google Drive export is opt-in and uses a separate Google OAuth connection
   with the least-privilege `drive.file` scope. The existing Calendar token is
   never assumed to have Drive permission; the UI explicitly asks the user to
   connect or reauthorize Drive.
5. The local extension meeting remains authoritative. Drive export is
   best-effort, retryable from the meeting view, and can never turn a saved
   recording into an error or block summary completion.
6. Drive output is a Google Doc titled with the meeting name and date, inside
   `My Drive/ai-notetaker`, using a stable format: metadata, summary, key
   decisions, action items, discussion highlights, open questions, and
   transcript.

## Boundaries

- No project-operated backend, account, billing, telemetry, or upload proxy.
- Secrets remain in `chrome.storage.local`.
- No TCP or localhost listener; the existing Native Messaging plus local
  Unix/named-pipe relay is the only extension/helper transport.
- Mic and speaker remain separate all the way to raw files and providers.
- Raw audio is persisted before provider calls.
- The committed manifest key is unchanged.
- Slack Huddles, Zoom, and Teams continue to use the helper/virtual-device
  instructions; only Google Meet gets browser capture.

## Acceptance criteria

- A Meet start creates a local meeting, establishes both stream tracks, and
  sends separate mic/speaker chunks to the helper.
- A malformed, oversized, or out-of-order browser chunk is rejected without
  crashing the helper or corrupting an existing recording.
- Stopping Meet releases tracks, closes the offscreen document, and causes the
  helper pipeline to flush and summarize exactly like desktop capture.
- Existing desktop start/stop wire messages and audio capture behavior remain
  backward compatible.
- Connecting Drive creates or reuses the exact `ai-notetaker` folder and
  creates a Google Doc with the prescribed format.
- Drive token expiry, API errors, duplicate folder names, and export retries
  have deterministic behavior and never delete the local meeting.
- Onboarding/settings tell a normal user which mode to choose, which devices
  to select for each meeting app, that Google Meet can use browser capture,
  and that exactly one transcription key plus one summarization key is needed.
