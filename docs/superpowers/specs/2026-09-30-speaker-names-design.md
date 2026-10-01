# Rename speakers (2026-09-30)

Status: implemented for the hosted webapp.

- Click a speaker label in a meeting's transcript to rename it ("Them 1" →
  "Sam Rivera", "You" → your name). Reset restores the default.
- Transcript rows keep stable keys (`you`, `them-1`, `speaker-2`). A new
  `MeetingSpeaker` row maps a key to a display name per meeting and records
  `appliedLabel`, the exact text currently written into the summary and action
  items for that speaker, so the next rename replaces precisely that text.
- Saving rewrites the old label in the summary, in action-item text and in
  action-item owners (whole words only: "Them 1" leaves "Them 10", "Sam" leaves
  "Samuel", possessives match). Renames of one meeting run one at a time under
  an advisory lock.
- Names are 2-60 characters, must be unique within the meeting (case
  insensitive, including other speakers' default labels) and cannot contain
  markdown-structural characters (`# * \` < > [ ] |` or backslashes).
- Shown in: the meeting page, shared links, Markdown/plain-text exports, Drive
  export, and Ask-your-notes evidence. Regenerated notes use the names and the
  prompt tells the model to use them exactly.
- Share links expose `speakerNames` but never `processingMode` or
  `notesRegenerations`.
- Not changed: the account data export still lists raw speaker keys; the
  summary rewrite also changes a capitalised "You" that is not the recorder if
  it appears in the notes.
