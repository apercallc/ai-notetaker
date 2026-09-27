/**
 * AudioWorklet processor for Meet capture. Runs on the audio rendering thread:
 * downmixes the input to mono, batches ~0.5 s of samples, and hands the
 * batch to the offscreen page as a transferred ArrayBuffer (no copy).
 * Built as its own bundle (meet/captureWorklet.js) and loaded with addModule().
 */

// The worklet global scope is not part of lib.dom; declare the little we use.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor): void;

class MeetCaptureProcessor extends AudioWorkletProcessor {
  private readonly chunkSamples: number;
  private buffer: Float32Array;
  private filled = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const requested = (options?.processorOptions as { chunkSamples?: unknown } | undefined)?.chunkSamples;
    this.chunkSamples = typeof requested === "number" && requested > 0 ? Math.floor(requested) : 24_000;
    this.buffer = new Float32Array(this.chunkSamples);
    this.port.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "flush") return;
      this.emit(true);
      this.port.postMessage({ type: "flushed" });
    };
  }

  private emit(partial: boolean): void {
    if (this.filled === 0) return;
    const out = partial ? this.buffer.slice(0, this.filled) : this.buffer;
    this.port.postMessage(out.buffer, [out.buffer]);
    this.buffer = new Float32Array(this.chunkSamples);
    this.filled = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const channelCount = input?.length ?? 0;
    if (!input || channelCount === 0) return true;
    const frames = input[0]?.length ?? 0;
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < channelCount; channel += 1) sum += input[channel]?.[frame] ?? 0;
      this.buffer[this.filled] = sum / channelCount;
      this.filled += 1;
      if (this.filled === this.chunkSamples) this.emit(false);
    }
    return true;
  }
}

registerProcessor("meet-capture", MeetCaptureProcessor);

export {};
