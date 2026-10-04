import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import sharedDesktopFixtureBase64 from "../test-fixtures/desktop-audio-transfer-v1.b64?raw";
import { DEFAULT_SETTINGS, type MeetingRecord } from "../src/types";
import { IDBFactory } from "fake-indexeddb";
import { appendBrowserMeetChunk, listBrowserMeetChunks } from "../src/meet/browserStorage";
import { createDesktopMigrationArchive, downloadDesktopMigrationArchive, saveDesktopAudioArchive } from "../src/lib/desktopMigration";

const completed: MeetingRecord = {
  id: "meeting-1",
  title: "Planning",
  startedAt: "2026-10-01T10:00:00.000Z",
  endedAt: "2026-10-01T10:30:00.000Z",
  transcript: [{ speaker: "you", text: "Ship it", timestamp: "2026-10-01T10:10:00.000Z", isFinal: true }],
  summary: "Ship the desktop app.",
  actionItems: [{ text: "Publish installers", owner: "Team", status: "open" }],
  status: "complete",
  mode: "standup",
};

describe("desktop migration archive", () => {
  it("streams saved Meet audio and notes into one archive without deleting source chunks", async () => {
    globalThis.indexedDB = new IDBFactory();
    const id = "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36";
    await appendBrowserMeetChunk(id, "mic", 2, new Uint8Array([5, 6]), 2_000);
    await appendBrowserMeetChunk(id, "mic", 0, new Uint8Array([1, 2]), 1_000);
    await appendBrowserMeetChunk(id, "speaker", 1, new Uint8Array([3, 4]), 1_500);
    expect(await listBrowserMeetChunks(id)).toHaveLength(3);
    const writes: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (value: Uint8Array | ArrayBuffer) => {
        writes.push(value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : value.slice());
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const picker = vi.fn(async () => ({ createWritable: async () => writer }));
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: picker });
    const sourceMeeting = { ...completed, id };
    const loadMeetings = vi.fn(async () => [sourceMeeting]);

    const result = await saveDesktopAudioArchive(DEFAULT_SETTINGS, loadMeetings, "2026-10-03T12:00:00.000Z");

    expect(picker).toHaveBeenCalledOnce();
    expect(loadMeetings).toHaveBeenCalledOnce();
    expect(result).toEqual({ meetingCount: 1, chunkCount: 3, audioBytes: 6 });
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.abort).not.toHaveBeenCalled();
    const all = new Uint8Array(writes.reduce((sum, item) => sum + item.length, 0));
    let offset = 0;
    for (const write of writes) { all.set(write, offset); offset += write.length; }
    const sharedDesktopFixture = Uint8Array.from(
      atob(sharedDesktopFixtureBase64.trim()),
      (byte) => byte.charCodeAt(0),
    );
    expect(all).toEqual(sharedDesktopFixture);
    expect(new TextDecoder().decode(all.subarray(0, 8))).toBe("NTKAR001");
    const manifestSize = new DataView(all.buffer).getUint32(8, true);
    const manifest = JSON.parse(new TextDecoder().decode(all.subarray(12, 12 + manifestSize))) as { notes: { meetings: unknown[]; settings: object }; audioMeetingIds: string[] };
    expect(manifest.notes.meetings).toHaveLength(1);
    expect(manifest.audioMeetingIds).toEqual([id]);
    expect(JSON.stringify(manifest)).not.toContain("apiKeys");
    expect(JSON.stringify(manifest)).not.toContain("accessToken");
    const audio = writes.slice(2).filter((write) => write.length === 62 && write[0] === 1);
    expect(audio).toHaveLength(3);
    expect(audio.map((frame) => new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(38, true)))
      .toEqual([0n, 1n, 2n]);
    expect((await listBrowserMeetChunks(id))).toHaveLength(3);
  });

  it("exports completed and partial note text plus portable preferences only", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.apiKeys.deepgram = "dg-secret";
    settings.webapp = { url: "https://notes.example.test", token: "sync-secret" };
    settings.calendar = { accessToken: "calendar-secret", expiresAt: 1 } as never;
    settings.drive = { accessToken: "drive-secret", clientId: "client", expiresAt: 1 };
    const unfinished = { ...completed, id: "meeting-2", status: "processing" as const, endedAt: null };
    const saved = { ...completed, id: "meeting-3", status: "saved" as const, summary: null, transcript: [], actionItems: [] };

    const archive = createDesktopMigrationArchive(settings, [completed, unfinished, saved], "2026-10-03T12:00:00.000Z");
    const encoded = JSON.stringify(archive);

    expect(archive.meetings).toEqual([
      expect.objectContaining({ id: completed.id, status: "complete", transcript: completed.transcript }),
      expect.objectContaining({ id: unfinished.id, status: "processing", endedAt: null }),
      expect.objectContaining({ id: saved.id, status: "saved", summary: null }),
    ]);
    expect(archive.settings).toEqual(expect.objectContaining({
      transcriptionProvider: settings.transcriptionProvider,
      summarizationProvider: settings.summarizationProvider,
      defaultMeetingMode: settings.defaultMeetingMode,
    }));
    expect(encoded).not.toContain("dg-secret");
    expect(encoded).not.toContain("sync-secret");
    expect(encoded).not.toContain("calendar-secret");
    expect(encoded).not.toContain("drive-secret");
    expect(encoded).not.toContain("managedProcessing");
    expect(encoded).not.toContain("audio");
  });

  it("downloads the archive as a JSON file", () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("ai-notetaker-desktop-transfer-2026-10-03.json");
      expect(this.href).toBe("blob:test");
    });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const archive = createDesktopMigrationArchive(DEFAULT_SETTINGS, [completed], "2026-10-03T12:00:00.000Z");

    downloadDesktopMigrationArchive(archive);

    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(document.body.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith("blob:test");
    click.mockRestore();
    create.mockRestore();
    revoke.mockRestore();
    vi.useRealTimers();
  });

  it("refuses to download a transfer file above the desktop import limit", () => {
    const archive = createDesktopMigrationArchive(DEFAULT_SETTINGS, [
      { ...completed, transcript: [{ speaker: "you" as const, text: "x".repeat(21 * 1024 * 1024), timestamp: "2026-10-01T10:10:00.000Z", isFinal: true }] },
    ]);

    expect(() => downloadDesktopMigrationArchive(archive)).toThrow(/20 MB/);
  });

  it("keeps audio-only recovery records in the manifest", async () => {
    globalThis.indexedDB = new IDBFactory();
    const id = "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36";
    await appendBrowserMeetChunk(id, "speaker", 0, new Uint8Array([1, 2]), 2_000);
    const writes: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (value: Uint8Array | ArrayBuffer) => { writes.push(value instanceof ArrayBuffer ? new Uint8Array(value) : value); }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: async () => ({ createWritable: async () => writer }) });

    await saveDesktopAudioArchive(DEFAULT_SETTINGS, async () => [], "2026-10-03T12:00:00.000Z");

    const manifestSize = new DataView(writes[0]!.buffer, writes[0]!.byteOffset).getUint32(8, true);
    const manifest = JSON.parse(new TextDecoder().decode(writes[1]!.subarray(0, manifestSize))) as { notes: { meetings: MeetingRecord[] } };
    expect(manifest.notes.meetings[0]).toMatchObject({ id, title: "Recovered Google Meet audio", startedAt: new Date(2_000).toISOString(), status: "error" });
  });

  it("aborts the archive when a saved PCM chunk is malformed", async () => {
    globalThis.indexedDB = new IDBFactory();
    const id = "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36";
    await appendBrowserMeetChunk(id, "mic", 0, new Uint8Array([1]));
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: async () => ({ createWritable: async () => writer }) });

    await expect(saveDesktopAudioArchive(DEFAULT_SETTINGS, async () => [completed])).rejects.toThrow(/invalid or too large/);

    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it("rejects oversized audio manifests and invalid audio timestamps", async () => {
    globalThis.indexedDB = new IDBFactory();
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: async () => ({ createWritable: async () => writer }) });
    const oversized = { ...completed, transcript: [{ speaker: "you" as const, text: "x".repeat(21 * 1024 * 1024), timestamp: "2026-10-01T10:10:00.000Z", isFinal: true }] };
    await expect(saveDesktopAudioArchive(DEFAULT_SETTINGS, async () => [oversized])).rejects.toThrow(/20 MB/);
    expect(writer.abort).toHaveBeenCalledOnce();

    globalThis.indexedDB = new IDBFactory();
    const id = "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36";
    await appendBrowserMeetChunk(id, "mic", 0, new Uint8Array([1, 2]), -1);
    writer.abort.mockClear();
    await expect(saveDesktopAudioArchive(DEFAULT_SETTINGS, async () => [{ ...completed, id }])).rejects.toThrow(/invalid timing/);
    expect(writer.abort).toHaveBeenCalledOnce();
  });

  it("rejects malformed meeting ids and invalid inventory sequences", async () => {
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: async () => ({ createWritable: async () => writer }) });

    globalThis.indexedDB = new IDBFactory();
    await appendBrowserMeetChunk("legacy-id", "mic", 0, new Uint8Array([1, 2]));
    await expect(saveDesktopAudioArchive(DEFAULT_SETTINGS, async () => [])).rejects.toThrow(/invalid meeting id/);
    expect(writer.abort).toHaveBeenCalledOnce();

    globalThis.indexedDB = new IDBFactory();
    await appendBrowserMeetChunk("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", "mic", -1, new Uint8Array([1, 2]));
    writer.abort.mockClear();
    await expect(saveDesktopAudioArchive(DEFAULT_SETTINGS, async () => [])).rejects.toThrow(/invalid sequence data/);
    expect(writer.abort).toHaveBeenCalledOnce();
  });
});
