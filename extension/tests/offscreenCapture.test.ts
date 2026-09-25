import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

function fakeTrack() {
  return { stop: vi.fn() };
}

interface FakeWorkletNode {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  options: unknown;
}
const workletNodes: FakeWorkletNode[] = [];
const addModule = vi.fn(async (_url: string) => undefined);

async function loadOffscreen(getUserMedia: (constraints: MediaStreamConstraints) => Promise<unknown>): Promise<Listener> {
  let listener: Listener | undefined;
  Object.assign(chromeMock.runtime, { onMessage: { addListener: vi.fn((fn: Listener) => { listener = fn; }) } });
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    constructor(_options?: unknown) {}
    close = vi.fn(async () => undefined);
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
    audioWorklet = { addModule };
    createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
  }
  workletNodes.length = 0;
  chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
  addModule.mockClear();
  class FakeAudioWorkletNode {
    connect = vi.fn();
    disconnect = vi.fn();
    port: FakeWorkletNode["port"] = {
      onmessage: null,
      // The real processor answers a flush with its partial buffer, then an ack.
      postMessage: (message) => {
        if ((message as { type?: string }).type !== "flush") return;
        this.port.onmessage?.({ data: new Float32Array([0.5, -0.5]).buffer });
        this.port.onmessage?.({ data: { type: "flushed" } });
      },
    };
    constructor(_context: unknown, _name: string, public options: unknown) {
      workletNodes.push(this as unknown as FakeWorkletNode);
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(getUserMedia) } });
  vi.resetModules();
  await import("../src/meet/offscreen");
  return listener!;
}

const WORKER = { id: "fake-extension-id", url: "chrome-extension://fake-extension-id/background.js" };

function send(listener: Listener, message: unknown, sender: unknown = WORKER): Promise<{ ok?: boolean; error?: string }> {
  return new Promise((resolve) => {
    listener(message, sender, (response) => resolve(response as { ok?: boolean; error?: string }));
  });
}

beforeEach(() => chromeMock.reset());
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("offscreen capture", () => {
  it("releases the captured tab when the microphone cannot be opened", async () => {
    // A tab whose stream is never released stays locked ("Cannot capture a tab
    // with an active stream") and cannot be captured again until reloaded.
    const tab = fakeTrack();
    const listener = await loadOffscreen(async (constraints) => {
      if ((constraints.audio as { mandatory?: unknown })?.mandatory) return { getTracks: () => [tab] };
      throw new DOMException("Requested device not found", "NotFoundError");
    });

    const response = await send(listener, { type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/Requested device not found/);
    await vi.waitFor(() => expect(tab.stop).toHaveBeenCalled());
  });

  it("starts both channels from the stream id handed over by the service worker", async () => {
    const tab = fakeTrack();
    const mic = fakeTrack();
    const listener = await loadOffscreen(async (constraints) => {
      const mandatory = (constraints.audio as { mandatory?: { chromeMediaSourceId?: string } })?.mandatory;
      return { getTracks: () => [mandatory ? tab : mic], seenId: mandatory?.chromeMediaSourceId };
    });

    expect(await send(listener, { type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" })).toEqual({ ok: true });
    const calls = (navigator.mediaDevices.getUserMedia as unknown as { mock: { calls: Array<[{ audio: { mandatory?: { chromeMediaSourceId: string } } }]> } }).mock.calls;
    expect(calls[0]?.[0].audio.mandatory?.chromeMediaSourceId).toBe("s1");
    expect(calls).toHaveLength(2);

    expect(await send(listener, { type: "MEET_CAPTURE_STOP", meetingId: "m1" })).toEqual({ ok: true });
    expect(tab.stop).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
  });

  it("loads the capture worklet from the extension bundle and runs one node per channel", async () => {
    const listener = await loadOffscreen(async () => ({ getTracks: () => [fakeTrack()] }));
    expect(await send(listener, { type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" })).toEqual({ ok: true });
    expect(addModule).toHaveBeenCalledWith("chrome-extension://fake-extension-id/meet/captureWorklet.js");
    expect(workletNodes).toHaveLength(2);
    expect(workletNodes[0]?.options).toMatchObject({ processorOptions: { chunkSamples: 24_000 } });
  });

  it("forwards worklet buffers as base64 PCM16 chunks per channel (speaker attached first)", async () => {
    const listener = await loadOffscreen(async () => ({ getTracks: () => [fakeTrack()] }));
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
    await send(listener, { type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" });

    const samples = new Float32Array(24_000).fill(0.5);
    workletNodes[0]?.port.onmessage?.({ data: samples.buffer });
    workletNodes[1]?.port.onmessage?.({ data: { type: "unrelated" } });

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const message = chromeMock.runtime.sendMessage.mock.calls[0]?.[0] as { type: string; meetingId: string; channel: string; sampleRateHz: number; pcm16Base64: string };
    expect(message).toMatchObject({ type: "MEET_AUDIO_CHUNK", meetingId: "m1", channel: "speaker", sampleRateHz: 48_000 });
    // 0.5 s of mono PCM16: under the service worker's 64 KiB limit even before base64.
    expect(atob(message.pcm16Base64).length).toBe(48_000);
    expect(atob(message.pcm16Base64).length).toBeLessThan(64 * 1024);
  });

  it("flushes the partial buffer before tearing down so the end of the call is kept", async () => {
    const listener = await loadOffscreen(async () => ({ getTracks: () => [fakeTrack()] }));
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
    await send(listener, { type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" });

    expect(await send(listener, { type: "MEET_CAPTURE_STOP", meetingId: "m1" })).toEqual({ ok: true });

    const chunks = chromeMock.runtime.sendMessage.mock.calls.map(([message]) => message as { channel: string; pcm16Base64: string });
    expect(chunks.map((chunk) => chunk.channel).sort()).toEqual(["mic", "speaker"]);
    expect(atob(chunks[0]!.pcm16Base64).length).toBe(4); // two samples
    workletNodes.forEach((node) => expect(node.disconnect).toHaveBeenCalled());
  });

  it("reports a capture error and stops when the service worker cannot be reached", async () => {
    const tab = fakeTrack();
    const listener = await loadOffscreen(async () => ({ getTracks: () => [tab] }));
    chromeMock.runtime.sendMessage.mockRejectedValue(new Error("no receiver"));
    await send(listener, { type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" });

    workletNodes[0]?.port.onmessage?.({ data: new Float32Array(24_000).buffer });

    await vi.waitFor(() => expect(tab.stop).toHaveBeenCalled());
    expect(chromeMock.runtime.sendMessage.mock.calls.some(([message]) => (message as { type: string }).type === "MEET_CAPTURE_ERROR")).toBe(true);
  });

  it("ignores a start without a stream id", async () => {
    const listener = await loadOffscreen(async () => ({ getTracks: () => [] }));
    expect(listener({ type: "MEET_CAPTURE_START", tabId: 3, meetingId: "m1" }, WORKER, () => {})).toBe(false);
  });

  it("only takes orders from the extension's own service worker, never the Meet content script", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    const listener = await loadOffscreen(getUserMedia);
    const fromPage = { id: "fake-extension-id", url: "https://meet.google.com/abc-defg-hij", tab: { id: 4 } };

    expect(listener({ type: "MEET_CAPTURE_START", streamId: "s1", meetingId: "m1" }, fromPage, () => {})).toBe(false);
    expect(listener({ type: "MEET_CAPTURE_STOP", meetingId: "m1" }, fromPage, () => {})).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
