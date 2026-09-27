import { describe, expect, it } from "vitest";
import { downsampleTo16k, msToSamples, pcm16ToWav, peakAmplitude, samplesToMs } from "../src/meet/wav";

describe("wav helpers", () => {
  it("writes a canonical PCM16 mono WAV header", () => {
    const wav = pcm16ToWav(Int16Array.from([1, -2, 300]), 16_000);
    const view = new DataView(wav.buffer);
    const tag = (offset: number): string => String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([1, -2, 300]);
  });

  it("averages each group of three 48 kHz samples and drops a trailing partial group", () => {
    const input = new Uint8Array(new Int16Array([3, 6, 9, -3, -6, -9, 100]).buffer);
    expect([...downsampleTo16k(input)]).toEqual([6, -6]);
  });

  it("converts between samples and milliseconds at 16 kHz and finds the peak", () => {
    expect(msToSamples(1000)).toBe(16_000);
    expect(samplesToMs(8_000)).toBe(500);
    expect(peakAmplitude(Int16Array.from([3, -900, 20]))).toBe(900);
  });
});
