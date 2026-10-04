/**
 * File types the import feature accepts. Dependency-free so the upload form
 * (client) and the server validate against the same list. The extension is a
 * first filter only: the worker's ffprobe decides whether the bytes are
 * really decodable audio.
 */
export const IMPORT_EXTENSIONS = [
  "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba",
  "webm", "mp4", "m4v", "mov", "mkv", "3gp",
] as const;

export type ImportExtension = (typeof IMPORT_EXTENSIONS)[number];

/** Chunk size the browser slices a file into; well under the server's per-chunk cap. */
export const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Lower-case extension if the file name is a supported import type, otherwise null. */
export function importFormatFromName(name: string): ImportExtension | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  const extension = match?.[1]?.toLowerCase();
  return extension && (IMPORT_EXTENSIONS as readonly string[]).includes(extension) ? (extension as ImportExtension) : null;
}

export function importAcceptAttribute(): string {
  return `${IMPORT_EXTENSIONS.map((extension) => `.${extension}`).join(",")},audio/*,video/*`;
}

/** Same ceiling the managed upload API enforces (kept below a signed 32-bit integer). */
export const IMPORT_MAX_BYTES = 1_900_000_000;

/** "1 h 5 min", "42 min", "under a minute". */
export function formatImportDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (total < 60) return "under a minute";
  const totalMinutes = Math.round(total / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function formatImportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}
