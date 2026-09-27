import { describe, expect, it, vi } from "vitest";
import { BYTES_PER_SAMPLE, parseRange, recordingStream, SAMPLE_RATE_HZ, wavHeader, WAV_HEADER_BYTES } from "./recordingStream";

describe("WAV header and HTTP byte ranges", () => {
  it("writes a standard mono 48 kHz 16-bit PCM header", () => {
    const header = wavHeader(1_234);
    const view = new DataView(header.buffer);
    expect(header.byteLength).toBe(WAV_HEADER_BYTES);
    expect(new TextDecoder().decode(header.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 1_234);
    expect(new TextDecoder().decode(header.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE_HZ);
    expect(view.getUint32(28, true)).toBe(SAMPLE_RATE_HZ * BYTES_PER_SAMPLE);
    expect(view.getUint16(32, true)).toBe(BYTES_PER_SAMPLE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(1_234);
  });

  it("parses closed, open-ended, suffix, and clamped ranges", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("items=0-2", 10)).toBeNull();
    expect(parseRange("bytes=-", 10)).toBeNull();
    expect(parseRange("bytes=2-", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange(" bytes=2-20 ", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange("bytes=-40", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=1-3", 10)).toEqual({ start: 1, end: 3 });
    expect(parseRange("bytes=8-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("lazy recording byte streams", () => {
  const header = Uint8Array.from({ length: 44 }, (_, index) => index);
  const chunks = [{ objectKey: "first", byteLength: 4 }, { objectKey: "second", byteLength: 3 }];
  const audio = new Map([
    ["first", Uint8Array.from([10, 11, 12, 13])],
    ["second", Uint8Array.from([20, 21, 22])],
  ]);

  it("streams only chunks overlapping the requested virtual file range", async () => {
    const read = vi.fn(async (key: string) => audio.get(key)!);
    const stream = recordingStream(header, chunks, { start: 46, end: 49 }, read);
    expect([...new Uint8Array(await new Response(stream).arrayBuffer())]).toEqual([12, 13, 20, 21]);
    expect(read.mock.calls.map(([key]) => key)).toEqual(["first", "second"]);
  });

  it("serves header-only ranges without loading audio objects", async () => {
    const read = vi.fn(async (key: string) => audio.get(key)!);
    const stream = recordingStream(header, chunks, { start: 0, end: 43 }, read);
    expect([...new Uint8Array(await new Response(stream).arrayBuffer())]).toEqual([...header]);
    expect(read).not.toHaveBeenCalled();
  });

  it("fails the response if stored object bytes differ from their recorded length", async () => {
    const stream = recordingStream(header, chunks, { start: 44, end: 47 }, async () => Uint8Array.of(1));
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("recording chunk size does not match its record");
  });

  it("does not fetch audio when the consumer cancels after reading the header", async () => {
    const read = vi.fn(async (key: string) => audio.get(key)!);
    const reader = recordingStream(header, chunks, { start: 0, end: 50 }, read).getReader();
    expect((await reader.read()).value).toEqual(header);
    await reader.cancel();
    expect(read).not.toHaveBeenCalled();
  });
});
