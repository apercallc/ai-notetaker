import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { appendBrowserMeetChunk, clearBrowserMeetChunks, lastBrowserMeetSequence, listBrowserMeetChunks, streamBrowserMeetChunks } from "../src/meet/browserStorage";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

beforeEach(() => {
  // A fresh database per test.
  globalThis.indexedDB = new IDBFactory();
});

async function collect(meetingId: string, batchSize?: number): Promise<number[]> {
  const sequences: number[] = [];
  for await (const chunk of streamBrowserMeetChunks(meetingId, batchSize)) sequences.push(chunk.sequence);
  return sequences;
}

describe("browser Meet chunk storage", () => {
  it("reads one meeting's chunks in numeric sequence order, never another meeting's", async () => {
    // Lexicographic key order would put "m1:10" before "m1:2".
    for (const sequence of [2, 10, 0, 1, 9]) await appendBrowserMeetChunk("m1", sequence % 2 === 0 ? "mic" : "speaker", sequence, bytes(sequence, 0));
    await appendBrowserMeetChunk("m2", "mic", 3, bytes(9, 9));

    const chunks = await listBrowserMeetChunks("m1");
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2, 9, 10]);
    expect(chunks[3]).toMatchObject({ channel: "speaker", sequence: 9 });
    expect([...chunks[0]!.bytes]).toEqual([0, 0]);
    expect((await listBrowserMeetChunks("m2")).map((chunk) => chunk.sequence)).toEqual([3]);
    expect(await listBrowserMeetChunks("missing")).toEqual([]);
  });

  it("stamps each chunk with its capture time", async () => {
    await appendBrowserMeetChunk("m1", "mic", 0, bytes(1, 2), 1_700_000_000_000);
    const before = Date.now();
    await appendBrowserMeetChunk("m1", "mic", 1, bytes(1, 2));
    const [first, second] = await listBrowserMeetChunks("m1");
    expect(first?.capturedAt).toBe(1_700_000_000_000);
    expect(second!.capturedAt!).toBeGreaterThanOrEqual(before);
  });

  it("streams in bounded batches, resuming after each one, across a batch boundary", async () => {
    for (let sequence = 0; sequence < 25; sequence += 1) await appendBrowserMeetChunk("m1", "mic", sequence, bytes(1, 2));
    await appendBrowserMeetChunk("m2", "mic", 5, bytes(1, 2));
    expect(await collect("m1", 10)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    // Exactly a multiple of the batch size must still terminate.
    expect(await collect("m1", 25)).toHaveLength(25);
    expect(await collect("nobody", 10)).toEqual([]);
  });

  it("survives awaiting non-IndexedDB work between chunks (transactions would otherwise expire)", async () => {
    for (let sequence = 0; sequence < 5; sequence += 1) await appendBrowserMeetChunk("m1", "mic", sequence, bytes(1, 2));
    const seen: number[] = [];
    for await (const chunk of streamBrowserMeetChunks("m1", 2)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(chunk.sequence);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports the last sequence without loading audio, or -1 when empty", async () => {
    expect(await lastBrowserMeetSequence("m1")).toBe(-1);
    for (const sequence of [0, 1, 2, 10]) await appendBrowserMeetChunk("m1", "mic", sequence, bytes(1, 2));
    await appendBrowserMeetChunk("m2", "mic", 99, bytes(1, 2));
    expect(await lastBrowserMeetSequence("m1")).toBe(10);
  });

  it("clears only the requested meeting", async () => {
    for (const sequence of [0, 1, 2]) await appendBrowserMeetChunk("m1", "mic", sequence, bytes(1, 2));
    await appendBrowserMeetChunk("m2", "mic", 0, bytes(1, 2));
    await clearBrowserMeetChunks("m1");
    expect(await listBrowserMeetChunks("m1")).toEqual([]);
    expect(await listBrowserMeetChunks("m2")).toHaveLength(1);
    await clearBrowserMeetChunks("m1"); // idempotent
  });

  it("upgrades a v1 database in place without losing a saved chunk", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ai-notetaker-meet-capture", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("chunks", { keyPath: "id" });
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("chunks", "readwrite");
        const store = transaction.objectStore("chunks");
        store.put({ id: "old:0", meetingId: "old", channel: "speaker", sequence: 0, bytes: new Uint8Array([7, 7]).buffer });
        store.put({ id: "old:1", meetingId: "old", channel: "mic", sequence: 1, bytes: new Uint8Array([8, 8]).buffer });
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    const migrated = await listBrowserMeetChunks("old");
    expect(migrated.map((chunk) => [chunk.channel, chunk.sequence, chunk.capturedAt])).toEqual([["speaker", 0, undefined], ["mic", 1, undefined]]);
    expect(await collect("old")).toEqual([0, 1]);
    expect(await lastBrowserMeetSequence("old")).toBe(1);
    await appendBrowserMeetChunk("old", "mic", 2, bytes(1, 2));
    expect(await collect("old")).toEqual([0, 1, 2]);
  });
});
