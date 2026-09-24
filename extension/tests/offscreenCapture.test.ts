import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

function fakeTrack() {
  return { stop: vi.fn() };
}

async function loadOffscreen(getUserMedia: (constraints: MediaStreamConstraints) => Promise<unknown>): Promise<Listener> {
  let listener: Listener | undefined;
  Object.assign(chromeMock.runtime, { onMessage: { addListener: vi.fn((fn: Listener) => { listener = fn; }) } });
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    constructor(_options?: unknown) {}
    close = vi.fn(async () => undefined);
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
    createScriptProcessor = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
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
