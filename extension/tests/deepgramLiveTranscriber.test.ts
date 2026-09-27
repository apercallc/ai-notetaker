import { describe, expect, it, vi } from "vitest";
import { DeepgramLiveTranscriber, type DeepgramLiveEvent } from "../src/meet/deepgramLiveTranscriber";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string, readonly protocols: string[]) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  result(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  static reset(): void { FakeSocket.instances = []; }
}

function makeTranscriber(events: DeepgramLiveEvent[]) {
  return new DeepgramLiveTranscriber({
    createSocket: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    onEvent: (event) => events.push(event),
    connectTimeoutMs: 50,
  });
}

describe("DeepgramLiveTranscriber", () => {
  it("streams mic and speaker audio separately using BYOK credentials", async () => {
    FakeSocket.reset();
    const events: DeepgramLiveEvent[] = [];
    const stream = makeTranscriber(events);
    const connected = stream.connect({ kind: "apiKey", token: "local-key" });
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances.every((socket) => socket.protocols[0] === "token" && socket.protocols[1] === "local-key")).toBe(true);
    FakeSocket.instances.forEach((socket) => socket.open());
    await connected;

    const pcm = new Uint8Array([1, 2, 3, 4]);
    stream.send("mic", pcm);
    stream.send("speaker", pcm);
    expect(FakeSocket.instances[0]?.sent).toEqual([pcm]);
    expect(FakeSocket.instances[1]?.sent).toEqual([pcm]);
    await stream.stop();
    expect(FakeSocket.instances.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it("converts interim and final results to stable speaker-labeled transcript events", async () => {
    FakeSocket.reset();
    const events: DeepgramLiveEvent[] = [];
    const stream = makeTranscriber(events);
    const connected = stream.connect({ kind: "jwt", token: "temporary-token" });
    expect(FakeSocket.instances.every((socket) => socket.protocols[0] === "bearer" && socket.protocols[1] === "temporary-token")).toBe(true);
    FakeSocket.instances.forEach((socket) => socket.open());
    await connected;

    FakeSocket.instances[0]?.result({
      type: "Results", is_final: false, start: 1.2,
      channel: { alternatives: [{ transcript: "hello there", words: [{ speaker: 0 }] }] },
    });
    FakeSocket.instances[0]?.result({
      type: "Results", is_final: true, start: 1.2,
      channel: { alternatives: [{ transcript: "hello there.", words: [{ speaker: 0 }] }] },
    });
    FakeSocket.instances[1]?.result({
      type: "Results", is_final: false, start: 2.5,
      channel: { alternatives: [{ transcript: "yes", words: [{ speaker: 1 }] }] },
    });

    expect(events.filter((event) => event.type === "transcript")).toEqual([
      { type: "transcript", channel: "mic", speaker: "you", text: "hello there", isFinal: false, utteranceId: 1, offsetMs: 1200 },
      { type: "transcript", channel: "mic", speaker: "you", text: "hello there.", isFinal: true, utteranceId: 1, offsetMs: 1200 },
      { type: "transcript", channel: "speaker", speaker: "them-2", text: "yes", isFinal: false, utteranceId: 1, offsetMs: 2500 },
    ]);
    await stream.stop();
  });

  it("fails closed on connection timeout without throwing an audio-capture dependency", async () => {
    FakeSocket.reset();
    const events: DeepgramLiveEvent[] = [];
    const stream = new DeepgramLiveTranscriber({
      createSocket: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
      onEvent: (event) => events.push(event),
      connectTimeoutMs: 1,
    });
    await expect(stream.connect({ kind: "apiKey", token: "local-key" })).rejects.toThrow(/timed out/i);
    expect(FakeSocket.instances.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    expect(events.some((event) => event.type === "status" && event.status === "unavailable")).toBe(true);
  });
});
