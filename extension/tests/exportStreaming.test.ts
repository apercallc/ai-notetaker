import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock } from "./setup";
import { buildDesktopMigrationArchiveFromStream, loadStoredMeetingStream } from "../src/lib/desktopMigration";
import { listMeetingExportMetadata, saveMeeting, streamMeetingsByRecency } from "../src/lib/storage";
import { DEFAULT_SETTINGS, type MeetingRecord } from "../src/types";

function meeting(id: string, startedAt: string, title = id): MeetingRecord {
  return {
    id,
    title,
    startedAt,
    endedAt: null,
    transcript: [],
    summary: null,
    actionItems: [],
    status: "saved",
    captureSource: "meet",
  };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

async function collect(source: AsyncIterable<MeetingRecord>): Promise<string[]> {
  const ids: string[] = [];
  for await (const item of source) ids.push(item.id);
  return ids;
}

async function* of(...items: MeetingRecord[]): AsyncGenerator<MeetingRecord> {
  for (const item of items) yield item;
}

beforeEach(() => {
  chromeMock.reset();
});

describe("meeting export metadata and streaming", () => {
  it("lists stored meetings newest first and ignores unreadable records", async () => {
    await saveMeeting(meeting(A, "2026-10-01T10:00:00.000Z"));
    await saveMeeting(meeting(B, "2026-10-03T10:00:00.000Z"));
    await chrome.storage.local.set({ "notetaker.meetingsIndex": [A, B, "missing"] });

    expect(await listMeetingExportMetadata()).toEqual([
      { id: B, startedAt: "2026-10-03T10:00:00.000Z" },
      { id: A, startedAt: "2026-10-01T10:00:00.000Z" },
    ]);
  });

  it("merges extra meetings into recency order without duplicating stored ones", async () => {
    await saveMeeting(meeting(A, "2026-10-01T10:00:00.000Z"));
    await saveMeeting(meeting(C, "2026-10-05T10:00:00.000Z"));

    const extras = [meeting(B, "2026-10-03T10:00:00.000Z"), meeting(A, "2026-10-09T10:00:00.000Z", "stale duplicate")];
    expect(await collect(streamMeetingsByRecency(extras))).toEqual([C, B, A]);
  });

  it("uses supplied metadata and skips records that vanished from storage", async () => {
    await saveMeeting(meeting(A, "2026-10-01T10:00:00.000Z"));
    const metadata = [
      { id: B, startedAt: "2026-10-02T10:00:00.000Z" },
      { id: A, startedAt: "2026-10-01T10:00:00.000Z" },
    ];
    expect(await collect(streamMeetingsByRecency([], metadata))).toEqual([A]);
  });

  it("counts audio-only recordings as recovered meetings in the stored stream", async () => {
    await saveMeeting(meeting(A, "2026-10-01T10:00:00.000Z"));
    const inventory = [
      { meetingId: A, chunkCount: 1, totalBytes: 2, firstCapturedAt: 1 },
      { meetingId: B, chunkCount: 2, totalBytes: 4, firstCapturedAt: Date.parse("2026-10-04T10:00:00.000Z") },
      { meetingId: C, chunkCount: 1, totalBytes: 1, firstCapturedAt: null },
    ] as unknown as Parameters<typeof loadStoredMeetingStream>[0];

    const { totalCount, meetings } = await loadStoredMeetingStream(inventory, "2026-10-10T00:00:00.000Z");
    expect(totalCount).toBe(3);
    const items: MeetingRecord[] = [];
    for await (const item of meetings) items.push(item);
    expect(items.map((item) => item.id)).toEqual([C, B, A]);
    expect(items[0]).toMatchObject({ title: "Recovered browser audio", startedAt: "2026-10-10T00:00:00.000Z", status: "error" });
    expect(items[1].startedAt).toBe("2026-10-04T10:00:00.000Z");
  });
});

describe("buildDesktopMigrationArchiveFromStream", () => {
  const exportedAt = "2026-10-10T00:00:00.000Z";

  it("keeps settings and valid meetings in stream order", async () => {
    const { archive, adjustments } = await buildDesktopMigrationArchiveFromStream(
      { ...DEFAULT_SETTINGS, customVocabulary: ["Kubernetes"] },
      of(meeting(B, "2026-10-03T10:00:00.000Z"), meeting(A, "2026-10-01T10:00:00.000Z")),
      2,
      exportedAt,
    );
    expect(archive.exportedAt).toBe(exportedAt);
    expect(archive.settings.customVocabulary).toEqual(["Kubernetes"]);
    expect(archive.meetings.map((item) => item.id)).toEqual([B, A]);
    expect(adjustments).toEqual([]);
  });

  it("leaves out meetings with an invalid id and says so", async () => {
    const { archive, adjustments } = await buildDesktopMigrationArchiveFromStream(
      DEFAULT_SETTINGS,
      of(meeting("not-a-uuid", "2026-10-03T10:00:00.000Z"), meeting(A, "2026-10-01T10:00:00.000Z")),
      2,
      exportedAt,
    );
    expect(archive.meetings.map((item) => item.id)).toEqual([A]);
    expect(adjustments[0]).toMatch(/1 meeting record was left out/);
  });

  it("stops at the size limit and reports how many were left out", async () => {
    const first = meeting(B, "2026-10-03T10:00:00.000Z");
    const second = meeting(A, "2026-10-01T10:00:00.000Z");
    const baseline = await buildDesktopMigrationArchiveFromStream(DEFAULT_SETTINGS, of(first), 1, exportedAt);
    const limit = new TextEncoder().encode(JSON.stringify(baseline.archive)).byteLength + 10;

    const { archive, adjustments } = await buildDesktopMigrationArchiveFromStream(DEFAULT_SETTINGS, of(first, second), 2, exportedAt, limit);
    expect(archive.meetings.map((item) => item.id)).toEqual([B]);
    expect(adjustments.join(" ")).toMatch(/1 remaining meeting record was not included/);
  });

  it("refuses to create an archive when even the newest meeting does not fit", async () => {
    await expect(
      buildDesktopMigrationArchiveFromStream(DEFAULT_SETTINGS, of(meeting(A, "2026-10-01T10:00:00.000Z")), 1, exportedAt, 100),
    ).rejects.toThrow(/cannot fit/);
  });
});
