// Streaming, Range-capable WAV delivery for recorded meeting audio.
//
// A recording is stored as sequential raw PCM chunks (mono, 16-bit, 48 kHz),
// each an object of at most 8 MiB. The previous route concatenated every
// chunk into one Uint8Array (up to ~1.9 GB) before responding. This builds
// the WAV on the fly instead: a generated 44-byte header followed by the
// chunks read one at a time, with backpressure, so memory stays bounded by a
// single chunk regardless of recording length.

export const SAMPLE_RATE_HZ = 48_000;
export const BYTES_PER_SAMPLE = 2;
export const WAV_HEADER_BYTES = 44;

export interface RecordingChunk {
  objectKey: string;
  byteLength: number;
}

export function wavHeader(pcmBytes: number): Uint8Array {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcmBytes, true);
  return new Uint8Array(buffer);
}

export type ByteRange = { start: number; end: number }; // inclusive, like HTTP

/**
 * Parse a single-range `Range: bytes=…` header against a resource of `size`
 * bytes. Returns null when there is no (usable) header — serve the whole
 * body — and "unsatisfiable" when the range lies outside the resource.
 * Multi-range requests are answered with the full body, which HTTP allows.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "unsatisfiable";
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * A ReadableStream of bytes `[range.start, range.end]` of the virtual file
 * `header ++ chunk[0] ++ chunk[1] ++ …`. Chunks are fetched lazily, one per
 * pull, and only those overlapping the range are read at all.
 */
export function recordingStream(
  header: Uint8Array,
  chunks: readonly RecordingChunk[],
  range: ByteRange,
  readChunk: (objectKey: string) => Promise<Uint8Array>,
): ReadableStream<Uint8Array> {
  let position = 0; // virtual offset of the start of the next segment
  let next = -1; // -1 = header not yet emitted
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled) {
        let bytes: Uint8Array;
        let length: number;
        if (next === -1) {
          bytes = header;
          length = header.byteLength;
        } else if (next < chunks.length) {
          const chunk = chunks[next]!;
          length = chunk.byteLength;
          const segmentEnd = position + length - 1;
          if (segmentEnd < range.start || position > range.end) {
            // Entirely outside the range: skip without touching storage.
            position += length;
            next += 1;
            continue;
          }
          bytes = await readChunk(chunk.objectKey);
          if (cancelled) return;
          if (bytes.byteLength !== length) {
            controller.error(new Error("recording chunk size does not match its record"));
            return;
          }
        } else {
          controller.close();
          return;
        }

        const from = Math.max(range.start - position, 0);
        const to = Math.min(range.end - position, length - 1);
        position += length;
        next += 1;
        if (to >= from) {
          controller.enqueue(bytes.subarray(from, to + 1));
          return;
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
