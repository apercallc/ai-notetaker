import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Fake timers leaking past a failing test would silently break every
// later test that awaits real microtask-driven promises — always restore.
afterEach(() => {
  vi.useRealTimers();
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

  describe("helper_not_found handling", () => {
    it("settles instead of hanging when connectNative itself throws — Chrome's synchronous unregistered-host mode", async () => {
      vi.useFakeTimers();
      chromeMock.runtime.connectNative.mockImplementation(() => {
        throw new Error("Specified native messaging host not found.");
      });
      const client = new NativeMessagingClient();
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));

      // The whole point: connect() is what the background worker awaits
      // before it can answer GET_STATE, so in the exact scenario this
      // state exists for (helper never installed) it must resolve.
      await expect(client.connect()).resolves.toBeUndefined();
      expect(statuses).toContain("helper_not_found");

      // The backoff retry still runs.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(2);
    });

    it("settles even when the helper dies between connect and hello (port nulled before sendHello completes)", async () => {
      vi.useFakeTimers();
      const port = createFakePort();
      chromeMock.runtime.connectNative.mockReturnValue(port);
      const client = new NativeMessagingClient();
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));

      const connectPromise = client.connect();
      // The helper vanishes before the awaited pairing-token read gets to
      // send() — handleDisconnect nulls this.port first, so sendHello()
      // rejects and connect() must still resolve rather than wedge.
      chromeMock.runtime.lastError = { message: "Specified native messaging host not found." };
      port._emitDisconnect();
      chromeMock.runtime.lastError = undefined;

      await expect(connectPromise).resolves.toBeUndefined();
      expect(statuses).toContain("helper_not_found");
    });

    it("reports helper_not_found and backs off instead of hot-looping when the host manifest is missing", async () => {
      vi.useFakeTimers();
      const ports: Array<ReturnType<typeof createFakePort>> = [];
      chromeMock.runtime.connectNative.mockImplementation(() => {
        const newPort = createFakePort();
        ports.push(newPort);
        return newPort;
      });
      const client = new NativeMessagingClient();
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));
      await client.connect();

      chromeMock.runtime.lastError = { message: "Specified native messaging host not found." };
      ports[0]?._emitDisconnect();
      chromeMock.runtime.lastError = undefined;

      expect(statuses).toContain("helper_not_found");
      // No immediate reconnect attempt — that would hot-loop against a
      // host that is definitionally not there.
      expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(2);

      // Second failure backs off further (2s, not another 1s).
      chromeMock.runtime.lastError = { message: "Specified native messaging host not found." };
      ports[1]?._emitDisconnect();
      chromeMock.runtime.lastError = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(2); // not yet — needs 2s this time
      await vi.advanceTimersByTimeAsync(1_000);
      expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(3);
    });

    it("an ordinary disconnect (no lastError) still reconnects immediately, not with backoff", async () => {
      const ports: Array<ReturnType<typeof createFakePort>> = [];
      chromeMock.runtime.connectNative.mockImplementation(() => {
        const newPort = createFakePort();
        ports.push(newPort);
        return newPort;
      });
      const client = new NativeMessagingClient();
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));
      await client.connect();

      ports[0]?._emitDisconnect();

      expect(statuses).toContain("disconnected");
      expect(statuses).not.toContain("helper_not_found");
      expect(chromeMock.runtime.connectNative).toHaveBeenCalledTimes(2);
    });

    it("reports connected once a real message arrives, and resets the backoff", async () => {
      const port = createFakePort();
      chromeMock.runtime.connectNative.mockReturnValue(port);
      const client = new NativeMessagingClient();
      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));
      await client.connect();

      port._emitMessage({ type: "paired", pairingToken: "tok" });

      expect(statuses).toContain("connected");
    });
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
    });

    it("returns a useful result instead of rejecting when the helper is disconnected", async () => {
      const client = new NativeMessagingClient();
      await expect(client.testProviderKey("groq", "some-key")).resolves.toEqual({
        valid: false,
        message: "The helper is not connected. Install and start it, then try again.",
      });
    });
  });
});
