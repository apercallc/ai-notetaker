// Constants the library UI (client) shares with lib/noteEditing.ts. No database imports.
export const MAX_NOTE_BODY = 100_000;
export const MAX_NOTE_TITLE = 200;
/** Largest .md/.txt file accepted as an upload, in bytes. */
export const MAX_NOTE_UPLOAD_BYTES = 512 * 1024;
export const NOTE_UPLOAD_EXTENSIONS = ["md", "markdown", "txt"] as const;
