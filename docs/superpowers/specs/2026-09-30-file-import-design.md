# File import: transcribe and summarize an audio or video file (2026-09-30)

Status: Phase 1 implemented (hosted webapp). Phase 2 (Local BYOK) designed, not built.

## Understanding
Let anyone turn an existing recording into the same notes a live call produces
(transcript, summary, action items), so it gets search, Ask-your-notes, sharing
and Drive export for free. On Hosted Pro/Team an import counts against the same
meeting-unit and audio-hour caps as live meetings and refunds on failure.

## Phase 1: hosted webapp (built)
- `/import` page (cookie session). Browser slices the file into 4 MiB chunks,
  SHA-256 each, uploads 3 in parallel with retry, resumes by idempotency key.
- `/api/import*` routes reuse the managed upload and job machinery:
  `ManagedUpload.kind = "import"`, `sourceFormat`, `declaredDurationSeconds`;
  `ProcessingJob.stage` for progress. The Bearer chunk handler is shared
  (`managedUploadChunk.ts`); cookie routes add Origin + custom-header CSRF checks.
- Worker decode stage (`mediaDecode.ts`): ffprobe container allowlist
  (refuses hls/concat/image2/...), `-protocol_whitelist file`, forced demuxer,
  first audio stream, 16 kHz mono PCM, output capped at plan max + 1 s, wall-clock
  timeout, scrubbed environment, prlimit CPU/file-size limits when available.
- Metering: reserve `estimateImportSeconds` at queue time; after decode,
  `adjustReservedAudioSeconds` sets the measured duration *before provider spend*
  and fails + refunds if it exceeds the plan. No-speech files are not charged.
- Transcription: live provider by default (Groq, no speaker labels);
  `MANAGED_IMPORT_TRANSCRIPTION_PROVIDER=deepgram` opts into diarization.
  Voices are stored as `speaker`/`speaker-N`, rendered "Speaker N".

### Deviations from the approved design (and why)
- **ffmpeg runs in the web process, not a separate worker.** Jobs execute inside
  the web service (the worker only polls and triggers `/jobs/:id/run`), so the
  shared image carries ffmpeg and isolation is the sandboxed child process above.
- **Deepgram is opt-in, not the default,** because it costs ~6x Groq per hour
  and would erode plan margins at 60 h/month.
- **Self-hosted without managed mode has no import page.** Those instances do
  no provider execution; Phase 2 covers them via BYOK.
- **Template and language pickers were not built;** notes templates are a
  separate feature (see TODO.md competitive list). Whisper auto-detects language.

## Phase 2: Local BYOK (not built)
Extension popup and helper "Import file": decode locally (Symphonia in the
helper, user's ffmpeg for video), run the existing BYOK pipeline, save a
`Meeting` with `captureSource = "import"`, `processingMode = "local_byok"`.
The source file stays local. Free, no account.
