/** Capture runs at 48 kHz mono PCM16 (see offscreen.ts). */
export const CAPTURE_SAMPLE_RATE_HZ = 48_000;
/** What we actually upload: Whisper resamples to 16 kHz anyway and Deepgram is fine with it, at a third of the bytes. */
export const TRANSCRIBE_SAMPLE_RATE_HZ = 16_000;
const DOWNSAMPLE_FACTOR = CAPTURE_SAMPLE_RATE_HZ / TRANSCRIBE_SAMPLE_RATE_HZ;

/** Wraps mono little-endian PCM16 in a canonical 44-byte-header RIFF/WAVE container. */
export function pcm16ToWav(samples: Int16Array, sampleRateHz: number = TRANSCRIBE_SAMPLE_RATE_HZ): Uint8Array {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const writeTag = (offset: number, tag: string): void => {
    for (let index = 0; index < tag.length; index += 1) view.setUint8(offset + index, tag.charCodeAt(index));
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);
  // Explicit little-endian writes keep this correct on any host byte order.
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index] ?? 0, true);
  return wav;
}

/**
 * Little-endian PCM16 bytes at 48 kHz -> 16 kHz samples by averaging each
 * group of three (a boxcar low-pass, plenty for speech). A trailing partial
 * group is dropped; callers feeding a continuous stream carry it over.
 */
export function downsampleTo16k(pcm16: Uint8Array): Int16Array {
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength - (pcm16.byteLength % 2));
  const input = Math.floor(view.byteLength / 2);
  const output = new Int16Array(Math.floor(input / DOWNSAMPLE_FACTOR));
  for (let index = 0; index < output.length; index += 1) {
    const base = index * DOWNSAMPLE_FACTOR * 2;
    output[index] = Math.round((view.getInt16(base, true) + view.getInt16(base + 2, true) + view.getInt16(base + 4, true)) / DOWNSAMPLE_FACTOR);
  }
  return output;
}

export function peakAmplitude(samples: Int16Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  return peak;
}

export function samplesToMs(sampleCount: number): number {
  return (sampleCount * 1000) / TRANSCRIBE_SAMPLE_RATE_HZ;
}

export function msToSamples(milliseconds: number): number {
  return Math.round((milliseconds * TRANSCRIBE_SAMPLE_RATE_HZ) / 1000);
}
