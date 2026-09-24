# Google Meet Browser Capture and Google Drive Export

## Goal

Make Google Meet the low-friction browser path while keeping Slack Huddles,
Zoom, and Microsoft Teams on the desktop-helper path. After a meeting is
summarized, optionally create a readable Google Doc in `My Drive/ai-notetaker`.
Meet remains local-first and can finish with free browser-owned BYOK or with
the authenticated managed service; Drive is downstream of either path.

> **Current product contract:** this focused design predates the dual-mode
> migration. Meet still owns browser capture and remains helperless, but the
> persisted channels may now be processed locally with BYOK or uploaded to the
> optional managed service after local durability is established.

## Decisions

1. The extension may capture Google Meet media. A long-lived offscreen document
   owns `tabCapture` and microphone streams; the extension persists raw audio
   locally before direct local-BYOK provider calls or managed upload. The
   helper remains the owner of desktop-call persistence, transcription,
   summarization, retries, and crash recovery. A connected helper may receive
   Meet chunks as an optimization, but it is not a Meet prerequisite.
2. Meet persists two independent PCM16 streams in extension IndexedDB:
   microphone and remote meeting audio. Chunks are bounded below the 1 MiB
   Chrome Native Messaging limit when a helper handoff is used and are
   rejected when oversized or malformed.
3. `start_recording` gains an explicit `captureSource` (`desktop` or `meet`).
   Desktop keeps the helper-owned cpal/parec/native-loopback pipeline. Meet
   stays extension-owned: local BYOK processing happens in the browser, while
   managed mode uploads only after local durability and registers the meeting
   with the hosted workspace.
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

- The dual-mode product may use the project-operated managed backend for
  authenticated hosted processing, usage, and billing. Local BYOK remains
  account-free and does not require that backend.
- Local secrets remain in `chrome.storage.local`; managed provider secrets
  remain server-side and never enter extension storage or meeting records.
- No TCP or localhost listener; the existing Native Messaging plus local
  Unix/named-pipe relay is the only extension/helper transport.
- Mic and speaker remain separate all the way to raw files and providers.
- Raw audio is persisted before provider calls.
- The committed manifest key is unchanged.
- Slack Huddles, Zoom, and Teams continue to use the helper/virtual-device
  instructions; only Google Meet gets browser capture.

## Acceptance criteria

- A Meet start creates a local meeting, establishes both stream tracks, and
  persists separate mic/speaker chunks in IndexedDB before processing. A
  helper handoff is optional.
- A malformed, oversized, or out-of-order browser chunk is rejected without
  crashing the helper or corrupting an existing recording.
- Stopping Meet releases tracks and closes the offscreen document. Browser-owned
  BYOK or managed processing then flushes the durable chunks; a helper handoff,
  when available, remains backward compatible with desktop processing.
- Existing desktop start/stop wire messages and audio capture behavior remain
  backward compatible.
- Connecting Drive creates or reuses the exact `ai-notetaker` folder and
  creates a Google Doc with the prescribed format.
- Drive token expiry, API errors, duplicate folder names, and export retries
  have deterministic behavior and never delete the local meeting.
- Onboarding/settings tell a normal user which mode to choose, which devices
  to select for each meeting app, that Google Meet can use browser capture,
  and that exactly one transcription key plus one summarization key is needed.
