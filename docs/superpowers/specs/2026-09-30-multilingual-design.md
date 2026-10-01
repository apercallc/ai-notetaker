# Multilingual notes: language, translated summaries, vocabulary (2026-09-30)

Status: implemented for hosted processing (live captures and imports). Local BYOK already had a
vocabulary option in the helper.

- **Vocabulary (workspace, Settings → Data):** up to 100 names/terms, one per line. Sent to
  Whisper as its `prompt` (kept within a ~600 character budget) and to Deepgram as `keyterm`
  parameters (first 50), and listed in the summarizer prompt to be spelled exactly.
- **Spoken language:** an optional hint on the import form (Whisper `language`, Deepgram
  `language`). With no hint Whisper detects the language and Deepgram is asked to
  `detect_language`. The detected language (ISO 639-1) is stored on the note and shown on its
  page; a hint the user chose is never overwritten by detection.
- **Translated summary:** a workspace default ("Write notes in") applies to every new summary,
  and "Regenerate notes" has its own "Write in" choice. The model is told to write the title,
  overview, key points, decisions, action items and section headings in that language while
  keeping names and quoted terms as spoken. 25 languages are offered (`lib/languages.ts`).
- **Audit:** `workspace.language_update` records the number of terms and the language, never the terms.

## Not verified / not built
- Deepgram's `detect_language` and `keyterm` parameters and Whisper's `prompt`/`language` fields
  are built to the documented API but have not been exercised against the live providers.
- Per-note translation of an existing summary into a second language (regenerate replaces the
  text), per-folder language defaults, right-to-left layout review, and local BYOK summary
  language.
