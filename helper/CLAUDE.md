# helper/ — Desktop Capture Helper

Tauri (Rust), not Electron — smaller install, one shared codebase across
macOS/Windows/Linux with small platform-specific audio modules, and Tauri's
built-in updater covers the "how do security patches reach users" gap. See
`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md` (§3.1)
for the full rationale.

## Conventions

- **This package owns the AI pipeline.** Audio chunking/streaming,
  transcription API calls, and summarization API calls all happen here, not
  in the extension. The extension is a display layer only.
- **Wrap existing virtual-audio drivers — don't build one.** BlackHole
  (macOS), VB-Cable (Windows), a PulseAudio/PipeWire null-sink module
  (Linux). A new low-level audio driver in this package is almost certainly
  the wrong move; if you think you need one, that's a decision to raise
  explicitly, not build quietly.
- **BlackHole and VB-Cable have different, verified redistribution terms —
  don't treat them the same.** macOS: never bundle Existential Audio's
  compiled BlackHole installer (GPL source, but the official binary and
  branding are separately all-rights-reserved) — detect-if-missing and
  deep-link to their official download instead. Windows: base VB-CABLE
  (never the A+B/C+D variants) may be bundled and silently installed, but
  VB-Audio's terms require the vb-cable.com attribution and donation option
  to stay visible in our installer UI.
- **Capture mic and speaker as separate channels/streams, always.** Never
  merge them into one blob before sending to the transcription API — the
  dual-channel split is what gives "you vs. everyone else" diarization for
  free.
- **Raw audio to local disk before any API call, every time.** No code path
  should send captured audio to a transcription provider without having
  already persisted it locally first. This is the resilience guarantee: a
  failed API call must never mean lost audio.
- **New providers implement the shared provider interface.** See the
  `notetaker-add-provider` skill before adding a transcription or LLM
  provider — it walks through preserving the resilience guarantee, honest
  streaming-vs-batch labeling, and cost documentation.
- **Native Messaging host, not an open port**, for talking to the
  extension.
- **Detect and offer to resume an in-progress recording on startup.**
  Because raw audio is written incrementally during capture, an unclean
  shutdown (crash, forced quit, OS restart) leaves recoverable audio behind
  — check for it on launch rather than leaving it orphaned.
