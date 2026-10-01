import { describe, expect, it } from "vitest";
import { managedAudioChunkSource, packManagedAudioChunks } from "../src/meet/managedAudioChunks";
import type { BrowserAudioChannel } from "../src/types";

async function* frames(values: Array<[BrowserAudioChannel, number[]]>) {
  for (const [channel, bytes] of values) yield { channel, bytes: new Uint8Array(bytes) };
}

describe("hosted audio packing", () => {
  it("preserves samples and channel order across frame and packing boundaries", async () => {
    const input: Array<[BrowserAudioChannel, number[]]> = [
      ["mic", [1, 2]], ["speaker", [9, 8]], ["mic", [3, 4, 5, 6, 7, 8]], ["speaker", [7, 6]], ["mic", [9, 10]],
    ];
    const output = [];
    for await (const chunk of packManagedAudioChunks(frames(input), 4)) output.push({ ...chunk, bytes: [...chunk.bytes] });
    expect(output).toEqual([
      { channel: "mic", index: 0, bytes: [1, 2, 3, 4] },
      { channel: "mic", index: 1, bytes: [5, 6, 7, 8] },
      { channel: "speaker", index: 2, bytes: [9, 8, 7, 6] },
      { channel: "mic", index: 3, bytes: [9, 10] },
    ]);
    const retry = [];
    for await (const chunk of packManagedAudioChunks(frames(input), 4)) retry.push({ ...chunk, bytes: [...chunk.bytes] });
    expect(retry).toEqual(output);
  });

  it("packs more than the server frame-count ceiling into two requests", async () => {
    async function* recording() {
      for (let index = 0; index < 20_000; index++) yield { channel: index % 2 === 0 ? "mic" as const : "speaker" as const, bytes: new Uint8Array([index % 256, 0]) };
    }
    const source = await managedAudioChunkSource(recording);
    if (Array.isArray(source)) throw new Error("Expected streamed source");
    expect(source).toMatchObject({ totalChunks: 2, totalBytes: 40_000, uploadLayout: "pcm4m-v1" });
    let count = 0;
    let totalBytes = 0;
    for await (const chunk of source.chunks) {
      count++;
      totalBytes += chunk.bytes.byteLength;
    }
    expect(count).toBe(source.totalChunks);
    expect(totalBytes).toBe(source.totalBytes);
  });

  it("rejects partial PCM samples and unsafe buffer sizes", async () => {
    for (const size of [0, 3, Number.MAX_SAFE_INTEGER]) {
      await expect(packManagedAudioChunks(frames([]), size).next()).rejects.toThrow("chunk size");
    }
    await expect(packManagedAudioChunks(frames([["mic", [1]]]), 4).next()).rejects.toThrow("complete PCM16");
  });
});
