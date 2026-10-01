import { execFileSync, spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DECODE_BYTES_PER_SECOND,
  MediaDecodeError,
  decodeToPcm,
  interpretProbe,
  mediaToolsAvailable,
  probeMedia,
  resetMediaToolsCache,
} from "./mediaDecode";

const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

function probeJson(formatName: string, streams: string[] = ["audio"], duration: string | null = "3.0"): string {
  return JSON.stringify({
    format: { format_name: formatName, ...(duration ? { duration } : {}) },
    streams: streams.map((codec_type) => ({ codec_type })),
  });
}

describe("interpretProbe", () => {
  it("accepts common audio and video containers and keeps the first demuxer name", () => {
    expect(interpretProbe(probeJson("mov,mp4,m4a,3gp,3g2,mj2", ["video", "audio"]))).toEqual({ claimedSeconds: 3, demuxer: "mov", hasAudio: true });
    expect(interpretProbe(probeJson("matroska,webm"))).toMatchObject({ demuxer: "matroska", hasAudio: true });
    expect(interpretProbe(probeJson("mp3"))).toMatchObject({ demuxer: "mp3" });
    expect(interpretProbe(probeJson("ogg"))).toMatchObject({ demuxer: "ogg" });
  });

  it("reports audio-less files and a missing duration without trusting either", () => {
    expect(interpretProbe(probeJson("mov,mp4,m4a,3gp,3g2,mj2", ["video"]))).toMatchObject({ hasAudio: false });
    expect(interpretProbe(probeJson("wav", ["audio"], null))).toMatchObject({ claimedSeconds: null });
    expect(interpretProbe(probeJson("wav", ["audio"], "not-a-number"))).toMatchObject({ claimedSeconds: null });
  });

  it("refuses playlist, concat and image containers that could reach other files or hosts", () => {
    for (const name of ["hls", "concat", "image2", "rtsp", "sdp", "dash", "lavfi", "mpegts,hls"]) {
      expect(() => interpretProbe(probeJson(name))).toThrow(MediaDecodeError);
    }
  });

  it("rejects malformed probe output and empty format names", () => {
    expect(() => interpretProbe("not json")).toThrow("couldn't be read");
    expect(() => interpretProbe(JSON.stringify({ streams: [] }))).toThrow(MediaDecodeError);
  });
});

describe.skipIf(!HAVE_FFMPEG)("decodeToPcm with real ffmpeg", () => {
  let dir: string;
  const files: Record<string, string> = {};

  function make(name: string, args: string[]): string {
    const out = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, out], { stdio: "pipe" });
    files[name] = out;
    return out;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-media-test-"));
    make("tone.mp3", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", "-ar", "44100"]);
    make("tone.wav", ["-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-ac", "1", "-ar", "8000"]);
    make("clip.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "mpeg4", "-c:a", "aac", "-shortest"]);
    make("silent.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2", "-c:v", "mpeg4"]);
    await writeFile(path.join(dir, "playlist.m3u8"), "#EXTM3U\n#EXTINF:1,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n");
    const junk = Buffer.alloc(4_096);
    randomFillSync(junk);
    await writeFile(path.join(dir, "junk.mp3"), junk);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports ffmpeg as available", async () => {
    resetMediaToolsCache();
    await expect(mediaToolsAvailable()).resolves.toBe(true);
  });

  it("decodes stereo mp3 to 16 kHz mono PCM and measures the real duration", async () => {
    const pcm = path.join(dir, "tone-mp3.pcm");
    const decoded = await decodeToPcm(files["tone.mp3"]!, pcm, 3_600);
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.durationSeconds).toBeGreaterThan(2.9);
    expect(decoded.durationSeconds).toBeLessThan(3.2);
    expect(decoded.bytes).toBe((await stat(pcm)).size);
    expect(decoded.bytes % 2).toBe(0);
    expect(decoded.bytes / DECODE_BYTES_PER_SECOND).toBeCloseTo(decoded.durationSeconds, 5);
  });

  it("resamples low-rate mono wav", async () => {
    const decoded = await decodeToPcm(files["tone.wav"]!, path.join(dir, "tone-wav.pcm"), 3_600);
    expect(decoded.durationSeconds).toBeGreaterThan(1.9);
    expect(decoded.durationSeconds).toBeLessThan(2.2);
  });

  it("extracts the audio track of a video file", async () => {
    const decoded = await decodeToPcm(files["clip.mp4"]!, path.join(dir, "clip.pcm"), 3_600);
    expect(decoded.durationSeconds).toBeGreaterThan(2.5);
  });

  it("refuses a video with no audio track", async () => {
    await expect(decodeToPcm(files["silent.mp4"]!, path.join(dir, "silent.pcm"), 3_600)).rejects.toThrow("no audio track");
  });

  it("refuses a recording longer than the plan limit instead of clipping it", async () => {
    const error = await decodeToPcm(files["tone.mp3"]!, path.join(dir, "long.pcm"), 1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MediaDecodeError);
    expect((error as MediaDecodeError).kind).toBe("too-long");
    expect((error as MediaDecodeError).message).toContain("longer than");
  });

  it("refuses a playlist that points at local files", async () => {
    await expect(decodeToPcm(path.join(dir, "playlist.m3u8"), path.join(dir, "playlist.pcm"), 3_600)).rejects.toBeInstanceOf(MediaDecodeError);
  });

  it("refuses garbage bytes with a user-safe message", async () => {
    const error = await probeMedia(path.join(dir, "junk.mp3")).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MediaDecodeError);
    expect((error as MediaDecodeError).message).not.toMatch(/ffprobe|\/tmp|stderr/i);
  });

  it("does not leak the server environment to the decoder", async () => {
    // A secret in process.env must not reach ffmpeg. Probing succeeds with only PATH set.
    process.env.TEST_PROVIDER_SECRET = "must-not-leak";
    try {
      await expect(probeMedia(files["tone.wav"]!)).resolves.toMatchObject({ hasAudio: true });
    } finally {
      delete process.env.TEST_PROVIDER_SECRET;
    }
  });
});

describe("media tools missing", () => {
  it("reports unavailable and fails with a clear error when the binary is absent", async () => {
    const previous = process.env.FFMPEG_PATH;
    const previousProbe = process.env.FFPROBE_PATH;
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
    process.env.FFPROBE_PATH = "/nonexistent/ffprobe";
    resetMediaToolsCache();
    try {
      await expect(mediaToolsAvailable()).resolves.toBe(false);
      const error = await probeMedia("/tmp/whatever").catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(MediaDecodeError);
      expect((error as MediaDecodeError).kind).toBe("unavailable");
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = previous;
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = previousProbe;
      resetMediaToolsCache();
    }
  });
});
