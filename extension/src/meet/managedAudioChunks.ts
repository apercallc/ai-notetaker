import type { BrowserAudioChannel } from "../types";
import type { ManagedChunk, ManagedChunkSource } from "../lib/managedClient";

/** Below the server's 8 MiB limit; at most two channel buffers are retained. */
export const MANAGED_AUDIO_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_LAYOUT = "pcm4m-v1";
type AudioFrame = { channel: BrowserAudioChannel; bytes: Uint8Array };

/**
 * Replayable durable frames are scanned for a manifest, then packed by channel.
 * Capture frame count must never determine HTTP/object count. Packing is stable
 * across retries, with a distinct layout key for pre-batching upload manifests.
 */
export async function managedAudioChunkSource(
  frames: () => AsyncIterable<AudioFrame>,
): Promise<ManagedChunkSource> {
  const sizes = { mic: 0, speaker: 0 };
  for await (const frame of frames()) sizes[frame.channel] += frame.bytes.byteLength;
  return {
    totalBytes: sizes.mic + sizes.speaker,
    totalChunks: Math.ceil(sizes.mic / MANAGED_AUDIO_CHUNK_BYTES) + Math.ceil(sizes.speaker / MANAGED_AUDIO_CHUNK_BYTES),
    uploadLayout: UPLOAD_LAYOUT,
    chunks: packManagedAudioChunks(frames()),
  };
}

export async function* packManagedAudioChunks(
  frames: AsyncIterable<AudioFrame>,
  chunkBytes = MANAGED_AUDIO_CHUNK_BYTES,
): AsyncGenerator<ManagedChunk> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 2 || chunkBytes % 2 !== 0 || chunkBytes > MANAGED_AUDIO_CHUNK_BYTES) {
    throw new Error("Managed audio chunk size must be even PCM16 bytes under 4 MiB");
  }
  const buffers = { mic: new Uint8Array(chunkBytes), speaker: new Uint8Array(chunkBytes) };
  const lengths = { mic: 0, speaker: 0 };
  let index = 0;
  for await (const frame of frames) {
    if (frame.bytes.byteLength % 2 !== 0) throw new Error("Managed audio must contain complete PCM16 samples");
    let offset = 0;
    while (offset < frame.bytes.byteLength) {
      const channel = frame.channel;
      const take = Math.min(chunkBytes - lengths[channel], frame.bytes.byteLength - offset);
      buffers[channel].set(frame.bytes.subarray(offset, offset + take), lengths[channel]);
      lengths[channel] += take;
      offset += take;
      if (lengths[channel] === chunkBytes) {
        yield { channel, index: index++, bytes: buffers[channel] };
        buffers[channel] = new Uint8Array(chunkBytes);
        lengths[channel] = 0;
      }
    }
  }
  for (const channel of ["mic", "speaker"] as const) {
    if (lengths[channel] > 0) yield { channel, index: index++, bytes: buffers[channel].slice(0, lengths[channel]) };
  }
}
