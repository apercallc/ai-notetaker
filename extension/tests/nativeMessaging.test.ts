import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { NativeMessagingClient } from "../src/lib/nativeMessaging";
import * as storage from "../src/lib/storage";

/** A fake chrome.runtime.Port good enough to drive the client under test. */
function createFakePort() {
  const listeners: {
    message: Array<(msg: unknown) => void>;
    disconnect: Array<() => void>;
  } = { message: [], disconnect: [] };
  return {
    postMessage: vi.fn(),
    onMessage: {
      addListener: (cb: (msg: unknown) => void) => listeners.message.push(cb),
    },
    onDisconnect: {
      addListener: (cb: () => void) => listeners.disconnect.push(cb),
    },
    // test helpers, not part of the real Port type
    _emitMessage(msg: unknown) {
      for (const cb of listeners.message) cb(msg);
    },
    _emitDisconnect() {
      for (const cb of listeners.disconnect) cb();
    },
  };
}

beforeEach(() => {
  chromeMock.reset();
});

describe("NativeMessagingClient", () => {
  it("connects to the exact host name from the protocol doc", () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);

    const client = new NativeMessagingClient();
    client.connect();

    expect(chromeMock.runtime.connectNative).toHaveBeenCalledWith("com.ainotetaker.helper");
  });

  it("sends a hello message with a null pairing token on first-ever connection", async () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);

    const client = new NativeMessagingClient();
    await client.connect();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "hello", pairingToken: null });
  });

  it("sends the previously stored pairing token on reconnect", async () => {
    await storage.savePairingToken("existing-token");
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);

    const client = new NativeMessagingClient();
    await client.connect();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "hello", pairingToken: "existing-token" });
  });

  it("persists a new pairing token when the helper sends 'paired'", async () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);
    const client = new NativeMessagingClient();
    await client.connect();

    port._emitMessage({ type: "paired", pairingToken: "new-token-123" });
    // storage writes are async; flush microtasks
    await Promise.resolve();
    await Promise.resolve();

    expect(await storage.getPairingToken()).toBe("new-token-123");
  });

  it("dispatches transcript_partial messages to registered listeners", async () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);
    const client = new NativeMessagingClient();
    await client.connect();

    const handler = vi.fn();
    client.on("transcript_partial", handler);

    port._emitMessage({
      type: "transcript_partial",
      meetingId: "m1",
      speaker: "you",
      text: "hello",
      isFinal: false,
    });

    expect(handler).toHaveBeenCalledWith({
      type: "transcript_partial",
      meetingId: "m1",
      speaker: "you",
      text: "hello",
      isFinal: false,
    });
  });

  it("ignores malformed messages instead of throwing", async () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);
    const client = new NativeMessagingClient();
    await client.connect();

    const handler = vi.fn();
    client.on("transcript_partial", handler);

    expect(() => port._emitMessage({ garbage: true })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("reconnects automatically on disconnect (MV3 service workers die and must resume)", async () => {
    // Real Chrome hands back a fresh Port object per connectNative() call —
    // model that here so a reconnect's new listener doesn't land on the same
    // array the first port's _emitDisconnect is iterating (that mismatch
    // caused an infinite reconnect loop the first time this test was written).
    const ports: Array<ReturnType<typeof createFakePort>> = [];
    chromeMock.runtime.connectNative.mockImplementation(() => {
      const newPort = createFakePort();
      ports.push(newPort);
      return newPort;
    });
    const client = new NativeMessagingClient();
    await client.connect();

    ports[0]?._emitDisconnect();

    // A second connectNative call means the client attempted to reconnect.
    expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(2);
  });

  it("sends start_recording with the given meeting id", async () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);
    const client = new NativeMessagingClient();
    await client.connect();

    client.startRecording("meeting-42");

    expect(port.postMessage).toHaveBeenCalledWith({ type: "start_recording", meetingId: "meeting-42" });
  });

  it("pushes current settings down to the helper", async () => {
    const port = createFakePort();
    chromeMock.runtime.connectNative.mockReturnValue(port);
    const client = new NativeMessagingClient();
    await client.connect();

    client.pushSettings({
      transcriptionProvider: "deepgram",
      summarizationProvider: "claude",
      apiKeys: { deepgram: "dg-key", claude: "cl-key" },
      webapp: null,
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "settings",
      transcriptionProvider: "deepgram",
      summarizationProvider: "claude",
      apiKeys: { deepgram: "dg-key", claude: "cl-key" },
      webapp: null,
    });
  });

  describe("testProviderKey", () => {
    it("sends test_provider_key and resolves with the matching provider_key_test_result", async () => {
      const port = createFakePort();
      chromeMock.runtime.connectNative.mockReturnValue(port);
      const client = new NativeMessagingClient();
      await client.connect();

      const resultPromise = client.testProviderKey("deepgram", "some-key");
      expect(port.postMessage).toHaveBeenCalledWith({ type: "test_provider_key", provider: "deepgram", key: "some-key" });

      port._emitMessage({ type: "provider_key_test_result", provider: "deepgram", valid: true, message: "Deepgram key is valid." });

      await expect(resultPromise).resolves.toEqual({ valid: true, message: "Deepgram key is valid." });
    });

    it("ignores a result for a different provider than the one being tested", async () => {
      const port = createFakePort();
      chromeMock.runtime.connectNative.mockReturnValue(port);
      const client = new NativeMessagingClient();
      await client.connect();

      const resultPromise = client.testProviderKey("claude", "some-key");
      port._emitMessage({ type: "provider_key_test_result", provider: "gemini", valid: true, message: "wrong provider" });
      port._emitMessage({ type: "provider_key_test_result", provider: "claude", valid: false, message: "Claude rejected this key." });

      await expect(resultPromise).resolves.toEqual({ valid: false, message: "Claude rejected this key." });
    });

    it("times out and resolves with a helpful message if the helper never replies", async () => {
      vi.useFakeTimers();
      const port = createFakePort();
      chromeMock.runtime.connectNative.mockReturnValue(port);
      const client = new NativeMessagingClient();
      await client.connect();

      const resultPromise = client.testProviderKey("groq", "some-key");
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(resultPromise).resolves.toEqual({
        valid: false,
        message: "Timed out waiting for the helper to respond. Is it running?",
      });
      vi.useRealTimers();
    });
  });
});
