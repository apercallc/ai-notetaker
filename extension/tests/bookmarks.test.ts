import { describe, expect, it } from "vitest";
import { MAX_BOOKMARKS_PER_MEETING, MAX_BOOKMARK_NOTE_LENGTH, describeBookmark, flaggedMomentsFor, formatOffset, normalizeBookmarkNote, transcriptIndexForBookmark, withBookmark } from "../src/lib/bookmarks";
import type { MeetingRecord } from "../src/types";

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m1",
    title: "Standup",
    startedAt: "2026-09-24T10:00:00.000Z",
    endedAt: null,
    transcript: [],
    summary: null,
    actionItems: [],
    status: "recording",
    ...overrides,
  };
}

describe("bookmarks", () => {
  it("stores the offset from the meeting start rather than a wall-clock time", () => {
    const updated = withBookmark(meeting(), "  ship it  ", new Date("2026-09-24T10:03:21.000Z"));
    expect(updated.bookmarks).toHaveLength(1);
    expect(updated.bookmarks?.[0]).toMatchObject({ offsetMs: 201_000, note: "ship it", createdAt: "2026-09-24T10:03:21.000Z" });
    expect(updated.bookmarks?.[0]?.id).toBeTruthy();
  });

  it("never produces a negative offset when the clock moved backwards", () => {
    const updated = withBookmark(meeting(), undefined, new Date("2026-09-24T09:00:00.000Z"));
    expect(updated.bookmarks?.[0]?.offsetMs).toBe(0);
  });

  it("does not mutate the original meeting and keeps earlier bookmarks", () => {
    const original = meeting();
    const once = withBookmark(original, "a", new Date("2026-09-24T10:00:10.000Z"));
    const twice = withBookmark(once, "b", new Date("2026-09-24T10:00:20.000Z"));
    expect(original.bookmarks).toBeUndefined();
    expect(twice.bookmarks?.map((bookmark) => bookmark.note)).toEqual(["a", "b"]);
  });

  it("caps the number of bookmarks per meeting", () => {
    const full = meeting({
      bookmarks: Array.from({ length: MAX_BOOKMARKS_PER_MEETING }, (_, index) => ({ id: `b${index}`, offsetMs: index, note: "", createdAt: "x" })),
    });
    expect(withBookmark(full, "one more")).toBe(full);
  });

  it("collapses whitespace and bounds note length", () => {
    expect(normalizeBookmarkNote("a\n\n  b\t c")).toBe("a b c");
    expect(normalizeBookmarkNote("x".repeat(1000))).toHaveLength(MAX_BOOKMARK_NOTE_LENGTH);
    expect(normalizeBookmarkNote(undefined)).toBe("");
  });

  it("formats offsets as m:ss and h:mm:ss", () => {
    expect(formatOffset(0)).toBe("0:00");
    expect(formatOffset(65_000)).toBe("1:05");
    expect(formatOffset(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatOffset(-5)).toBe("0:00");
  });

  it("describes a bookmark with its time and note, or a default label", () => {
    expect(describeBookmark({ id: "b", offsetMs: 61_000, note: "Budget", createdAt: "x" })).toBe("1:01 — Budget");
    expect(describeBookmark({ id: "b", offsetMs: 61_000, note: "", createdAt: "x" })).toBe("1:01 — Flagged moment");
  });

  it("finds the transcript line spoken at or after a bookmark", () => {
    const withTranscript = meeting({
      transcript: [
        { speaker: "you", text: "a", timestamp: "2026-09-24T10:00:10.000Z", isFinal: true },
        { speaker: "them", text: "b", timestamp: "2026-09-24T10:01:00.000Z", isFinal: true },
        { speaker: "you", text: "c", timestamp: "2026-09-24T10:02:00.000Z", isFinal: true },
      ],
    });
    const at = (offsetMs: number) => ({ id: "b", offsetMs, note: "", createdAt: "x" });

    expect(transcriptIndexForBookmark(withTranscript, at(5_000))).toBe(0);
    expect(transcriptIndexForBookmark(withTranscript, at(30_000))).toBe(1);
    expect(transcriptIndexForBookmark(withTranscript, at(600_000))).toBe(2);
    expect(transcriptIndexForBookmark(meeting(), at(1))).toBe(-1);
  });

  it("measures each flag's position against the real length of the call", () => {
    const flagged = meeting({
      bookmarks: [
        { id: "a", offsetMs: 30_000, note: "early", createdAt: "x" },
        { id: "b", offsetMs: 90_000, note: "", createdAt: "x" },
        { id: "c", offsetMs: 500_000, note: "after the clock", createdAt: "x" },
      ],
    });
    const twoMinutesIn = Date.parse(flagged.startedAt) + 120_000;

    expect(flaggedMomentsFor(flagged, twoMinutesIn)).toEqual([
      { offsetMs: 30_000, note: "early", positionPercent: 25 },
      { offsetMs: 90_000, note: "", positionPercent: 75 },
      { offsetMs: 500_000, note: "after the clock", positionPercent: 100 },
    ]);
  });

  it("leaves the position out when the call has no measurable length", () => {
    const flagged = meeting({ bookmarks: [{ id: "a", offsetMs: 0, note: "x", createdAt: "x" }] });
    expect(flaggedMomentsFor(flagged, Date.parse(flagged.startedAt))).toEqual([{ offsetMs: 0, note: "x" }]);
    expect(flaggedMomentsFor(meeting(), Date.now())).toEqual([]);
  });
});
