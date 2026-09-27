import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSummaryReply, processBrowserMeetRecording, type BrowserMeetChunk } from "../src/meet/browserProcessing";
import { DEFAULT_SETTINGS, type NotetakerSettings } from "../src/types";

const START = "2026-09-24T10:00:00.000Z";
const START_MS = Date.parse(START);

function settings(overrides: Partial<NotetakerSettings> = {}): NotetakerSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    apiKeys: { deepgram: "dg-key", claude: "claude-key", ...(overrides.apiKeys ?? {}) },
  };
}

/** 48 kHz mono PCM16: a tone (speech stand-in) or silence. */
function pcm(ms: number, amplitude = 8_000): Uint8Array {
  const samples = (ms * 48_000) / 1000;
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, Math.round(amplitude * Math.sin(index / 20)), true);
  return bytes;
}

/** One-second chunks from `fromMs`, stamped as if captured live. */
function chunkRun(channel: "mic" | "speaker", startSequence: number, seconds: number, amplitude = 8_000, fromMs = 0): BrowserMeetChunk[] {
  return Array.from({ length: seconds }, (_, index) => ({
    channel,
    sequence: startSequence + index,
    bytes: pcm(1000, amplitude),
    capturedAt: START_MS + fromMs + (index + 1) * 1000,
  }));
}

function claudeReply(body: unknown): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] }), { status: 200 });
}

const NOTES = {
  title: "Launch planning.",
  overview: "The team agreed to ship on Friday.",
  key_points: ["Scope is frozen"],
  decisions: ["Ship Friday"],
  action_items: [{ text: "Write release notes", owner: "Dana", due: "2026-09-26" }, { text: "Tell support", owner: null, due: "Thursday" }],
};

function deepgramUtterances(...utterances: Array<[number, number, string]>): Response {
  return new Response(JSON.stringify({ results: { utterances: utterances.map(([start, end, transcript]) => ({ start, end, transcript })) } }), { status: 200 });
}

/** jsdom's Blob has no arrayBuffer(); FileReader is what it does implement. */
function blobBytes(body: unknown): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(body as Blob);
  });
}

afterEach(() => vi.useRealTimers());

describe("browser Meet processing", () => {
  it("sends WAV to Deepgram per channel and interleaves both channels chronologically by call offset", async () => {
    const wavs: Array<{ bytes: Uint8Array; url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.deepgram.com")) {
        wavs.push({ bytes: await blobBytes(init?.body), url, headers: init?.headers as Record<string, string> });
        // Two calls: the mic (sequence 0..3) first, then the speaker.
        return wavs.length === 1
          ? deepgramUtterances([0.5, 1.5, "Hi everyone."], [30, 31, "Let me share my screen."])
          : deepgramUtterances([10, 12, "Hello, thanks for joining."]);
      }
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const request = JSON.parse(String(init?.body)) as { max_tokens: number; messages: Array<{ content: string }> };
      expect(request.max_tokens).toBeGreaterThanOrEqual(2048);
      expect(request.messages[0]?.content).toContain("[0:10] Them: Hello, thanks for joining.");
      return claudeReply(NOTES);
    });

    const result = await processBrowserMeetRecording(
      settings(),
      "general",
      // Deliberately unordered: the processor must restore sequence order.
      [...chunkRun("speaker", 4, 4), ...chunkRun("mic", 0, 4)],
      fetchImpl,
      { startedAt: START },
    );

    expect(wavs).toHaveLength(2);
    for (const { url, bytes, headers } of wavs) {
      expect(url).toContain("utterances=true");
      expect(url).toContain("smart_format=true");
      // A WAV header describes the audio; raw-audio params would contradict it.
      expect(url).not.toMatch(/encoding=|sample_rate=/);
      expect(headers["Content-Type"]).toBe("audio/wav");
      expect(headers.Authorization).toBe("Token dg-key");
      const text = new TextDecoder();
      expect(text.decode(bytes.subarray(0, 4))).toBe("RIFF");
      expect(text.decode(bytes.subarray(8, 12))).toBe("WAVE");
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      expect(view.getUint32(24, true)).toBe(16_000);
      expect(view.getUint16(22, true)).toBe(1);
      expect(bytes.byteLength).toBe(44 + 4 * 16_000 * 2); // 4 s downsampled to 16 kHz
    }
    expect(result.transcript.map((line) => [line.speaker, line.text, line.offsetMs])).toEqual([
      ["you", "Hi everyone.", 500],
      ["them", "Hello, thanks for joining.", 10_000],
      ["you", "Let me share my screen.", 30_000],
    ]);
    // timestamp = startedAt + offset, which is what bookmark jump compares against.
    expect(result.transcript[1]?.timestamp).toBe(new Date(START_MS + 10_000).toISOString());
    expect(result.transcript.map((line) => line.utteranceId)).toEqual([0, 1, 2]);
    expect(result.title).toBe("Launch planning");
    expect(result.summary).toBe("The team agreed to ship on Friday.\n\nKey points:\n- Scope is frozen\n\nDecisions:\n- Ship Friday");
    expect(result.actionItems).toEqual([
      { text: "Write release notes", owner: "Dana", dueAt: "2026-09-26T00:00:00.000Z" },
      { text: "Tell support (due Thursday)" },
    ]);
    expect(result.structured?.decisions).toEqual(["Ship Friday"]);
  });

  it("uses Groq verbose_json with a WAV file and drops likely hallucinations on silence", async () => {
    let form: FormData | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith("https://api.groq.com")) {
        form = init?.body as FormData;
        return new Response(
          JSON.stringify({
            text: "ignored when segments exist",
            segments: [
              { start: 1.25, end: 3, text: " We should hire two engineers.", avg_logprob: -0.2, no_speech_prob: 0.01 },
              { start: 4, end: 5, text: " Thank you.", avg_logprob: -1.8, no_speech_prob: 0.9 },
            ],
          }),
          { status: 200 },
        );
      }
      return claudeReply(NOTES);
    });

    const result = await processBrowserMeetRecording(
      settings({ transcriptionProvider: "groq", apiKeys: { groq: "gq-key", claude: "claude-key" } }),
      "general",
      chunkRun("speaker", 0, 3),
      fetchImpl,
      { startedAt: START },
    );

    expect(form?.get("model")).toBe("whisper-large-v3-turbo");
    expect(form?.get("response_format")).toBe("verbose_json");
    expect(form?.getAll("timestamp_granularities[]")).toEqual(["segment"]);
    const file = form?.get("file") as File;
    expect(file.name).toBe("meet-segment.wav");
    expect(new TextDecoder().decode((await blobBytes(file)).subarray(0, 4))).toBe("RIFF");
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0]).toMatchObject({ speaker: "them", text: "We should hire two engineers.", offsetMs: 1250 });
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer gq-key");
  });

  it("processes a long call from a stream in bounded ~5 minute segments, under the Groq 25 MB cap", async () => {
    const sizes: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith("https://api.deepgram.com")) {
        sizes.push((init?.body as Blob).size);
        return deepgramUtterances([1, 2, `segment ${sizes.length}`]);
      }
      return claudeReply(NOTES);
    });
    let produced = 0;
    async function* eleven_minutes(): AsyncGenerator<BrowserMeetChunk> {
      for (let second = 0; second < 660; second += 1) {
        produced += 1;
        yield { channel: "speaker", sequence: second, bytes: pcm(1000), capturedAt: START_MS + (second + 1) * 1000 };
      }
    }

    const result = await processBrowserMeetRecording(settings(), "general", eleven_minutes(), fetchImpl, { startedAt: START });

    expect(produced).toBe(660);
    expect(sizes).toHaveLength(3);
    for (const size of sizes) expect(size).toBeLessThan(25 * 1024 * 1024);
    // Each segment is cut within the last 15 s of the 5 minute target.
    expect(sizes[0]! - 44).toBeGreaterThanOrEqual(285 * 16_000 * 2);
    expect(sizes[0]! - 44).toBeLessThanOrEqual(300 * 16_000 * 2 + 2);
    expect(sizes.reduce((sum, size) => sum + size - 44, 0)).toBe(660 * 16_000 * 2);
    const offsets = result.transcript.map((line) => line.offsetMs);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[1]).toBeGreaterThanOrEqual(285_000);
    expect(offsets[1]).toBeLessThanOrEqual(305_000);
  });

  it("starts a new segment at the real offset when chunks were dropped", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://api.deepgram.com") ? deepgramUtterances([0, 1, "spoken"]) : claudeReply(NOTES),
    );
    const result = await processBrowserMeetRecording(
      settings(),
      "general",
      [...chunkRun("speaker", 0, 2), ...chunkRun("speaker", 2, 2, 8_000, 62_000)],
      fetchImpl,
      { startedAt: START },
    );
    expect(result.transcript.map((line) => line.offsetMs)).toEqual([0, 62_000]);
  });

  it("falls back to cumulative offsets and a derived start for chunks saved without capture times", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://api.deepgram.com") ? deepgramUtterances([1, 2, "old audio"]) : claudeReply(NOTES),
    );
    const legacy = chunkRun("speaker", 0, 3).map(({ capturedAt: _ignored, ...chunk }) => chunk);
    const result = await processBrowserMeetRecording(settings(), "general", legacy, fetchImpl);
    expect(result.transcript[0]?.offsetMs).toBe(1000);
    expect(Number.isFinite(Date.parse(result.transcript[0]!.timestamp))).toBe(true);
  });

  it("does not upload a silent channel (muted mic) and merges a speaker's back-to-back utterances into one turn", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://api.deepgram.com")
        ? deepgramUtterances([0, 1, "First part."], [1.4, 2, "Second part."], [10, 11, "Later."])
        : claudeReply(NOTES),
    );
    const result = await processBrowserMeetRecording(
      settings(),
      "general",
      [...chunkRun("mic", 0, 3, 0), ...chunkRun("speaker", 3, 12)],
      fetchImpl,
      { startedAt: START },
    );
    const deepgramCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("deepgram"));
    expect(deepgramCalls).toHaveLength(1);
    expect(result.transcript.map((line) => line.text)).toEqual(["First part. Second part.", "Later."]);
  });

  it("marks a call without speech and never calls the summarizer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => deepgramUtterances());
    const result = await processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 2), fetchImpl, { startedAt: START });
    expect(result).toMatchObject({ transcript: [], summary: "No speech detected in this recording.", actionItems: [], noSpeech: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockClear();
    const silent = await processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 2, 0), fetchImpl);
    expect(silent.noSpeech).toBe(true);
    const empty = await processBrowserMeetRecording(settings(), "general", [], fetchImpl);
    expect(empty.noSpeech).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails fast on a missing key before uploading any audio", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      processBrowserMeetRecording(settings({ apiKeys: { deepgram: "dg-key", claude: undefined } }), "general", chunkRun("speaker", 0, 2), fetchImpl),
    ).rejects.toThrow("Missing claude API key");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reduces a long transcript with map-reduce instead of one giant prompt", async () => {
    const prompts: string[] = [];
    const longLine = "x".repeat(400);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith("https://api.deepgram.com")) {
        return deepgramUtterances(...Array.from({ length: 200 }, (_, index): [number, number, string] => [index * 3, index * 3 + 1, `${index} ${longLine}`]));
      }
      const prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0]!.content;
      prompts.push(prompt);
      return claudeReply(prompt.includes("<notes part=") ? { ...NOTES, overview: "Merged overview" } : { ...NOTES, overview: `part ${prompts.length}` });
    });

    const result = await processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 4), fetchImpl, { startedAt: START });

    const maps = prompts.filter((prompt) => prompt.includes("<transcript>"));
    const reduces = prompts.filter((prompt) => prompt.includes("<notes part="));
    expect(maps.length).toBeGreaterThanOrEqual(3);
    expect(reduces).toHaveLength(1);
    for (const prompt of maps) expect(prompt.length).toBeLessThan(40_000);
    expect(result.summary.startsWith("Merged overview")).toBe(true);
  });

  it("keeps the plain-text summary when the model does not return JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("https://api.deepgram.com") ? deepgramUtterances([0, 1, "hello"]) : claudeReply("The team met and agreed to ship."),
    );
    const result = await processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 2), fetchImpl, { startedAt: START });
    expect(result.summary).toBe("The team met and agreed to ship.");
    expect(result.actionItems).toEqual([]);
    expect(result.structured).toBeUndefined();
  });

  it("summarizes with Gemini and DeepSeek in JSON mode with a generous token budget", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.deepgram.com")) return deepgramUtterances([0, 1, "hello"]);
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> });
      return url.includes("gemini")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(NOTES) }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(NOTES) } }] }), { status: 200 });
    });
    for (const provider of ["gemini", "deepseek"] as const) {
      const result = await processBrowserMeetRecording(
        settings({ summarizationProvider: provider, apiKeys: { deepgram: "dg-key", [provider]: "sum-key" } }),
        "general",
        chunkRun("speaker", 0, 2),
        fetchImpl,
        { startedAt: START },
      );
      expect(result.title).toBe("Launch planning");
    }
    expect(seen[0]?.url).not.toContain("key=");
    expect(seen[0]?.headers["x-goog-api-key"]).toBe("sum-key");
    expect((seen[0]?.body.generationConfig as { responseMimeType: string }).responseMimeType).toBe("application/json");
    expect(seen[1]?.body).toMatchObject({ response_format: { type: "json_object" }, max_tokens: 4096 });
  });

  it("retries a transient browser provider failure before completing", async () => {
    vi.useFakeTimers();
    let deepgramCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("https://api.deepgram.com")) {
        deepgramCalls += 1;
        return deepgramCalls === 1 ? new Response("busy", { status: 503 }) : deepgramUtterances([0, 1, "recoverable speech"]);
      }
      return claudeReply({ ...NOTES, overview: "Recovered" });
    });
    const pending = processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 2), fetchImpl, { startedAt: START });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.summary.startsWith("Recovered")).toBe(true);
    expect(deepgramCalls).toBe(2);
  });

  it("does not retry a permanent browser provider failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("bad key", { status: 401 }));
    await expect(processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 2), fetchImpl)).rejects.toThrow("Deepgram returned 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up on a stalled upload after retries instead of hanging", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 2), fetchImpl);
    const assertion = expect(pending).rejects.toThrow("Deepgram timed out");
    // 2 s of audio -> 60 s base + 1 s; three attempts plus backoff.
    await vi.advanceTimersByTimeAsync(3 * 62_000 + 5_000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("scales the request timeout with segment length", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    // 40 s of audio: 60 s base + 20 s.
    const pending = processBrowserMeetRecording(settings(), "general", chunkRun("speaker", 0, 40), fetchImpl);
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still waiting on attempt 1 at 70 s
    await vi.advanceTimersByTimeAsync(4 * 90_000);
    await assertion;
  });
});

describe("parseSummaryReply", () => {
  it("accepts fenced JSON and embedded JSON", () => {
    expect(parseSummaryReply("```json\n" + JSON.stringify(NOTES) + "\n```").structured?.overview).toBe(NOTES.overview);
    expect(parseSummaryReply(`Here you go: ${JSON.stringify(NOTES)} hope it helps`).structured?.decisions).toEqual(["Ship Friday"]);
  });

  it("accepts the legacy {summary, action_items} shape", () => {
    const parsed = parseSummaryReply(JSON.stringify({ summary: "Old shape", action_items: [{ text: "Do it", owner: "Sam" }] }));
    expect(parsed.structured).toMatchObject({ overview: "Old shape", actionItems: [{ text: "Do it", owner: "Sam" }] });
  });

  it("salvages the overview from a reply truncated mid-JSON", () => {
    expect(parseSummaryReply('{"title":"T","overview":"They met and agreed.","key_points":["a","b').plainText).toBe("They met and agreed.");
  });

  it("drops junk owners and non-object items without throwing", () => {
    const parsed = parseSummaryReply(JSON.stringify({ overview: "x", action_items: [{ text: "A", owner: "unknown" }, 5, null, "plain string item"] }));
    expect(parsed.structured?.actionItems).toEqual([{ text: "A" }, { text: "plain string item" }]);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseSummaryReply("   ")).toEqual({});
  });
});
