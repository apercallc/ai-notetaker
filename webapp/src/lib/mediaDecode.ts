import { spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";

/**
 * Decodes user-supplied audio/video into 16 kHz mono PCM for transcription.
 *
 * Uploaded files are untrusted input to a large C codebase, so every ffmpeg
 * call is boxed in: argument arrays only (no shell), a scrubbed environment,
 * network and playlist protocols disabled, an allowlist of container formats
 * checked by ffprobe before ffmpeg ever decodes, a hard output-length cap, a
 * wall-clock timeout, and (where available) kernel CPU and file-size limits.
 * Messages on MediaDecodeError are safe to show to the person who uploaded.
 */
export class MediaDecodeError extends Error {
  constructor(message: string, readonly kind: "invalid" | "too-long" | "unavailable" | "timeout" = "invalid") {
    super(message);
    this.name = "MediaDecodeError";
  }
}

export const DECODE_SAMPLE_RATE_HZ = 16_000;
export const DECODE_BYTES_PER_SAMPLE = 2;
export const DECODE_BYTES_PER_SECOND = DECODE_SAMPLE_RATE_HZ * DECODE_BYTES_PER_SAMPLE;

const PROBE_TIMEOUT_MS = 60_000;
const MAX_DECODE_TIMEOUT_MS = 30 * 60_000;
const MAX_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;

/** ffprobe `format_name` tokens for containers we accept. Anything else (HLS, concat, image2, ...) is refused. */
const ALLOWED_FORMATS = new Set([
  "mov", "mp4", "m4a", "3gp", "3g2", "mj2",
  "matroska", "webm",
  "mp3", "wav", "ogg", "flac", "aac", "amr",
]);

function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

let prlimitAvailable: boolean | undefined;
function hasPrlimit(): boolean {
  if (prlimitAvailable === undefined) {
    try {
      prlimitAvailable = spawnSync("prlimit", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      prlimitAvailable = false;
    }
  }
  return prlimitAvailable;
}

interface ToolResult {
  code: number | null;
  stdout: string;
  stderrTail: string;
}

interface ToolOptions {
  timeoutMs: number;
  /** Kernel CPU-seconds limit (needs prlimit). */
  cpuSeconds?: number;
  /** Kernel limit on any single file the tool writes (needs prlimit). */
  fileSizeBytes?: number;
}

function runTool(binary: string, args: string[], options: ToolOptions): Promise<ToolResult> {
  const limits = [
    ...(options.cpuSeconds ? [`--cpu=${Math.ceil(options.cpuSeconds)}`] : []),
    ...(options.fileSizeBytes ? [`--fsize=${Math.ceil(options.fileSizeBytes)}`] : []),
  ];
  const limited = limits.length > 0 && hasPrlimit();
  const command = limited ? "prlimit" : binary;
  const commandArgs = limited ? [...limits, "--", binary, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // Nothing from the server's environment (provider keys, database URL)
      // is visible to the decoder process.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new MediaDecodeError("Reading this file took too long. Try a shorter or smaller file.", "timeout")));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_TOOL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new MediaDecodeError("This file's metadata is unusually large and was rejected.")));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(error.code === "ENOENT"
        ? new MediaDecodeError("File import isn't available on this server.", "unavailable")
        : new MediaDecodeError("File import couldn't start. Try again later.", "unavailable")));
    });
    child.on("close", (code) => finish(() => {
      // prlimit exits 127 when the wrapped binary cannot be executed.
      if (limited && code === 127) reject(new MediaDecodeError("File import isn't available on this server.", "unavailable"));
      else resolve({ code, stdout, stderrTail });
    }));
  });
}

let toolsAvailable: Promise<boolean> | undefined;

/** Whether ffmpeg and ffprobe can run here. Cached: the answer cannot change without a redeploy. */
export function mediaToolsAvailable(): Promise<boolean> {
  toolsAvailable ??= Promise.all([
    runTool(ffmpegBinary(), ["-version"], { timeoutMs: 10_000 }),
    runTool(ffprobeBinary(), ["-version"], { timeoutMs: 10_000 }),
  ]).then(([ffmpeg, ffprobe]) => ffmpeg.code === 0 && ffprobe.code === 0, () => false);
  return toolsAvailable;
}

/** Test hook: forget the cached availability answer. */
export function resetMediaToolsCache(): void {
  toolsAvailable = undefined;
  prlimitAvailable = undefined;
}

export interface ProbeResult {
  /** Container's own duration claim, when it has one. Never trusted for billing. */
  claimedSeconds: number | null;
  /** First demuxer name to force when decoding. */
  demuxer: string;
  hasAudio: boolean;
}

interface ProbeJson {
  format?: { format_name?: unknown; duration?: unknown };
  streams?: Array<{ codec_type?: unknown }>;
}

/** Parses ffprobe's JSON and enforces the container allowlist. Exported for tests. */
export function interpretProbe(raw: string): ProbeResult {
  let json: ProbeJson;
  try {
    json = JSON.parse(raw) as ProbeJson;
  } catch {
    throw new MediaDecodeError("This file couldn't be read as audio or video.");
  }
  const names = typeof json.format?.format_name === "string" ? json.format.format_name.split(",").map((name) => name.trim()).filter(Boolean) : [];
  if (names.length === 0 || !names.every((name) => ALLOWED_FORMATS.has(name))) {
    throw new MediaDecodeError("This file type isn't supported. Use an mp3, m4a, wav, ogg, flac, webm, mp4, mov or mkv file.");
  }
  const hasAudio = (json.streams ?? []).some((stream) => stream?.codec_type === "audio");
  const duration = typeof json.format?.duration === "string" || typeof json.format?.duration === "number" ? Number(json.format.duration) : NaN;
  return {
    claimedSeconds: Number.isFinite(duration) && duration >= 0 ? duration : null,
    demuxer: names[0]!,
    hasAudio,
  };
}

// ffprobe has no -nostdin; its stdin is /dev/null from spawn anyway.
const PROBE_SAFETY_ARGS = ["-hide_banner", "-protocol_whitelist", "file"];
const FFMPEG_SAFETY_ARGS = ["-nostdin", ...PROBE_SAFETY_ARGS];

export async function probeMedia(path: string): Promise<ProbeResult> {
  const result = await runTool(
    ffprobeBinary(),
    [...PROBE_SAFETY_ARGS, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", path],
    { timeoutMs: PROBE_TIMEOUT_MS, cpuSeconds: 60 },
  );
  if (result.code !== 0) throw new MediaDecodeError("This file couldn't be read as audio or video. It may be corrupt or in an unsupported format.");
  return interpretProbe(result.stdout);
}

export interface DecodedAudio {
  pcmPath: string;
  bytes: number;
  /** Real length of the decoded audio. This is what usage is billed on. */
  durationSeconds: number;
  sampleRate: number;
}

/**
 * Probes and decodes `sourcePath` to a raw 16 kHz mono s16le file at `pcmPath`.
 * Output is capped at `maxSeconds`; anything longer fails with kind "too-long"
 * instead of being silently truncated and billed as shorter than it is.
 */
export async function decodeToPcm(sourcePath: string, pcmPath: string, maxSeconds: number): Promise<DecodedAudio> {
  const probe = await probeMedia(sourcePath);
  if (!probe.hasAudio) throw new MediaDecodeError("This file has no audio track to transcribe.");
  if (probe.claimedSeconds !== null && probe.claimedSeconds > maxSeconds) {
    throw new MediaDecodeError(`This recording is longer than the ${formatLimit(maxSeconds)} your plan allows for one file.`, "too-long");
  }

  // Decode one second past the limit so an over-long file is detected, not clipped.
  const capSeconds = maxSeconds + 1;
  const capBytes = capSeconds * DECODE_BYTES_PER_SECOND;
  const result = await runTool(
    ffmpegBinary(),
    [
      ...FFMPEG_SAFETY_ARGS, "-loglevel", "error",
      "-f", probe.demuxer, "-i", sourcePath,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", String(DECODE_SAMPLE_RATE_HZ), "-acodec", "pcm_s16le",
      "-t", String(capSeconds), "-fs", String(capBytes),
      "-f", "s16le", "-y", pcmPath,
    ],
    {
      timeoutMs: Math.min(MAX_DECODE_TIMEOUT_MS, 120_000 + maxSeconds * 100),
      cpuSeconds: Math.min(1_800, 120 + maxSeconds / 4),
      fileSizeBytes: capBytes + 1024 * 1024,
    },
  );
  if (result.code !== 0) throw new MediaDecodeError("This file couldn't be decoded. It may be corrupt or use an unsupported codec.");

  const { size } = await stat(pcmPath);
  const usable = size - (size % DECODE_BYTES_PER_SAMPLE);
  if (usable <= 0) throw new MediaDecodeError("No audio could be read from this file.");
  const durationSeconds = usable / DECODE_BYTES_PER_SECOND;
  if (durationSeconds > maxSeconds) {
    throw new MediaDecodeError(`This recording is longer than the ${formatLimit(maxSeconds)} your plan allows for one file.`, "too-long");
  }
  return { pcmPath, bytes: usable, durationSeconds, sampleRate: DECODE_SAMPLE_RATE_HZ };
}

function formatLimit(seconds: number): string {
  const hours = seconds / 3_600;
  return Number.isInteger(hours) ? `${hours}-hour` : `${Math.round(seconds / 60)}-minute`;
}
