import { describe, expect, it, vi } from "vitest";
import { processBrowserMeetRecording } from "../src/meet/browserProcessing";
import { DEFAULT_SETTINGS, type NotetakerSettings } from "../src/types";

function settings(overrides: Partial<NotetakerSettings> = {}): NotetakerSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    apiKeys: { deepgram: "dg-key", claude: "claude-key", ...(overrides.apiKeys ?? {}) },
  };
}

describe("browser Meet processing", () => {
  it("transcribes both browser channels and summarizes without a helper", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.deepgram.com")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Token dg-key");
        const channel = url.includes("utterances=true") ? "line" : "line";
        return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: channel }] }] } }), { status: 200 });
      }
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("claude-key");
      return new Response(JSON.stringify({ content: [{ text: JSON.stringify({ summary: "Decided next steps", action_items: [{ text: "Ship the browser path", owner: "You" }] }) }] }), { status: 200 });
    });

    const result = await processBrowserMeetRecording(
      settings(),
      "general",
      [
        { channel: "mic", sequence: 0, bytes: new Uint8Array([1, 2]) },
        { channel: "speaker", sequence: 1, bytes: new Uint8Array([3, 4]) },
      ],
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.transcript).toHaveLength(2);
    expect(result.summary).toBe("Decided next steps");
    expect(result.actionItems[0]?.text).toBe("Ship the browser path");
  });

  it("does not call the summarizer when transcription has no speech", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }), { status: 200 }));
    await expect(
      processBrowserMeetRecording(settings(), "general", [{ channel: "speaker", sequence: 0, bytes: new Uint8Array([1, 2]) }], fetchImpl),
    ).rejects.toThrow("No speech");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transient browser provider failure before completing", async () => {
    let deepgramCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.deepgram.com")) {
        deepgramCalls += 1;
        if (deepgramCalls === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "recoverable speech" }] }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: [{ text: JSON.stringify({ summary: "Recovered", action_items: [] }) }] }), { status: 200 });
    });

    const result = await processBrowserMeetRecording(
      settings(),
      "general",
      [{ channel: "speaker", sequence: 0, bytes: new Uint8Array([1, 2]) }],
      fetchImpl,
    );

    expect(result.summary).toBe("Recovered");
    expect(deepgramCalls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent browser provider failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("bad key", { status: 401 }));

    await expect(
      processBrowserMeetRecording(settings(), "general", [{ channel: "speaker", sequence: 0, bytes: new Uint8Array([1, 2]) }], fetchImpl),
    ).rejects.toThrow("Deepgram returned 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
