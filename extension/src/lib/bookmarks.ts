import type { Bookmark, MeetingRecord } from "../types";

export const MAX_BOOKMARKS_PER_MEETING = 200;
export const MAX_BOOKMARK_NOTE_LENGTH = 280;

export function normalizeBookmarkNote(note: string | undefined): string {
  return (note ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_BOOKMARK_NOTE_LENGTH);
}

/** Returns the meeting with one more bookmark, or the same meeting when the cap is reached. */
export function withBookmark(meeting: MeetingRecord, note: string | undefined, now: Date = new Date()): MeetingRecord {
  const existing = meeting.bookmarks ?? [];
  if (existing.length >= MAX_BOOKMARKS_PER_MEETING) return meeting;
  const offsetMs = Math.max(0, now.getTime() - Date.parse(meeting.startedAt));
  const bookmark: Bookmark = {
    id: crypto.randomUUID(),
    offsetMs: Number.isFinite(offsetMs) ? offsetMs : 0,
    note: normalizeBookmarkNote(note),
    createdAt: now.toISOString(),
  };
  return { ...meeting, bookmarks: [...existing, bookmark] };
}

/** `m:ss` under an hour, `h:mm:ss` from an hour up. */
export function formatOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Bookmarks as the helper's summarizer wants them: offset, note, and where in the call they fall. */
export function flaggedMomentsFor(meeting: MeetingRecord, now: number = Date.now()): Array<{ offsetMs: number; note: string; positionPercent?: number }> {
  const callLengthMs = now - Date.parse(meeting.startedAt);
  return (meeting.bookmarks ?? []).map(({ offsetMs, note }) => ({
    offsetMs,
    note,
    ...(callLengthMs > 0 ? { positionPercent: Math.max(0, Math.min(100, Math.round((offsetMs * 100) / callLengthMs))) } : {}),
  }));
}

export function describeBookmark(bookmark: Bookmark): string {
  return `${formatOffset(bookmark.offsetMs)} — ${bookmark.note || "Flagged moment"}`;
}

/** Index of the first transcript line spoken at or after the bookmark, or the last line if none is. */
export function transcriptIndexForBookmark(meeting: MeetingRecord, bookmark: Bookmark): number {
  if (meeting.transcript.length === 0) return -1;
  const target = Date.parse(meeting.startedAt) + bookmark.offsetMs;
  const index = meeting.transcript.findIndex((segment) => Date.parse(segment.timestamp) >= target);
  return index === -1 ? meeting.transcript.length - 1 : index;
}
