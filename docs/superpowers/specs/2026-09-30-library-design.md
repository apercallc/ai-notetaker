# Library: Drive-style folders for notes (2026-09-30)

Status: implemented in the webapp (hosted and self-hosted).

## What it is
A library of **notes** (transcript, summary, action items), not recordings (audio
is never kept). Notes are Markdown text, shown as `Title.md`, organized in nested
folders with search, a text-only editor, and a Trash. Works for a solo user's own
workspace and for teams (folders are workspace-wide; per-folder access control and
per-person private folders are follow-ups).

## Behavior
- **Folders:** nest up to 8 levels; up to 2,000 per workspace; names are unique
  among siblings ignoring case (partial unique index over live folders); create,
  rename, move (no cycles, depth cap checked against the moved subtree).
- **Browsing** shows exactly one folder (folders first, then notes), like Drive.
  **Search or a date filter** looks through the current folder and its subfolders,
  or everywhere on request, and shows each result's folder path. The nav item is
  "Library"; the URL stays `/meetings`, and `/meetings/:id` is the note view.
- **Notes:** "New note" (opens the editor), "Upload .md/.txt" (browser reads the
  text; up to 512 KB; no binary), plus every transcribed meeting and import.
  Hand-written/uploaded notes (`captureSource = manual`) have no transcript, are
  never sent to a provider and export as just their text.
- **Editing is text only and covers the note body.** Plain Markdown textarea with
  Write/Preview, explicit Save (Ctrl/Cmd+S), unsaved-changes warning, and a
  version check: saving refuses to overwrite a note that changed since the editor
  loaded. The transcript stays read-only. The replaced text is kept once
  (`previousSummary`) so an edit or a regeneration can be undone ("Restore earlier
  version" swaps, and swaps back).
- **Delete = Trash for 30 days.** Deleting a note or folder hides it everywhere
  (lists, search, Ask, action items, shares, regenerate, speaker rename, Drive
  export); a folder takes its subfolders and notes with it. Each item carries a
  `trashRootId`, so restoring a folder returns exactly what went with it and not
  what was trashed separately earlier. Restore falls back to the top level when the
  parent is gone and renames on a name clash ("Plans (restored)"). Items are purged
  after 30 days by the worker heartbeat, and by page loads on instances without a
  worker (hourly, bounded). "Delete forever" and "Empty trash" remove at once.
- **Teams:** an owner may delete anything; a member may delete their own notes and
  folders whose contents are all theirs, otherwise an owner must. Only owners empty
  the trash. Moving, renaming and editing are open to every member.
- **Ask your notes** can be scoped to a folder and its subfolders.
- **Audit:** folder.create/rename/move/trash/restore/purge, meeting.create/edit/
  move/trash/restore/purge, trash.empty/trash.purge (ids and counts only).

## Not built
- Per-folder or per-person permissions, drag-and-drop, multi-select, tags,
  stars, folder sharing, autosave and edit history beyond one level.
- Account data export still lists notes flat and includes trashed notes.
