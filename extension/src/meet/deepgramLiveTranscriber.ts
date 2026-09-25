import type { BrowserAudioChannel, Speaker } from "../types";

export type DeepgramCredential =
  | { kind: "apiKey"; token: string }
  | { kind: "jwt"; token: string };

export type DeepgramLiveEvent =
  | { type: "status"; status: "connecting" | "available" | "unavailable" | "not_supported"; message?: string }
  | {
      type: "transcript";
      channel: BrowserAudioChannel;
      speaker: Speaker;
      text: string;
      isFinal: boolean;
      utteranceId: number;
      offsetMs: number;
    };

export interface DeepgramLiveTranscriberOptions {
  createSocket?: (url: string, protocols: string[]) => WebSocket;
  onEvent: (event: DeepgramLiveEvent) => void;
  connectTimeoutMs?: number;
}

const LIVE_URL = "wss://api.deepgram.com/v1/listen";
const MAX_PENDING_CHUNKS_PER_CHANNEL = 8;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function speakerFor(channel: BrowserAudioChannel, value: unknown): Speaker {
  if (channel === "mic") return "you";
  const number = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return number === 0 ? "them" : `them-${number + 1}`;
}

export class DeepgramLiveTranscriber {
  private readonly sockets = new Map<BrowserAudioChannel, WebSocket>();
  private readonly pending = new Map<BrowserAudioChannel, Uint8Array[]>([["mic", []], ["speaker", []]]);
  private readonly activeUtterances = new Map<string, number>();
  private readonly nextUtterance = new Map<string, number>();
  private stopped = false;
  private readonly createSocket: (url: string, protocols: string[]) => WebSocket;
  private readonly connectTimeoutMs: number;

  constructor(private readonly options: DeepgramLiveTranscriberOptions) {
    this.createSocket = options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  async connect(credential: DeepgramCredential): Promise<void> {
    this.stopped = false;
    this.options.onEvent({ type: "status", status: "connecting" });
    const protocols = credential.kind === "apiKey" ? ["token", credential.token] : ["bearer", credential.token];
    const url = new URL(LIVE_URL);
    url.search = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: "48000",
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      diarize_model: "latest",
      utterance_end_ms: "1000",
    }).toString();

    try {
      await Promise.all(([
        ["mic", protocols],
        ["speaker", protocols],
      ] as const).map(([channel, authProtocols]) => this.openChannel(channel, url.toString(), authProtocols)));
      if (!this.stopped) this.options.onEvent({ type: "status", status: "available" });
    } catch (error) {
      this.closeSockets();
      const message = error instanceof Error ? error.message : "Live transcription could not connect";
      this.options.onEvent({ type: "status", status: "unavailable", message });
      throw error;
    }
  }

  send(channel: BrowserAudioChannel, pcm16: Uint8Array): void {
    if (this.stopped) return;
    const socket = this.sockets.get(channel);
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(pcm16);
      } catch {
        this.fail("The live transcript connection was interrupted");
      }
      return;
    }
    const queue = this.pending.get(channel);
    if (queue && queue.length < MAX_PENDING_CHUNKS_PER_CHANNEL) queue.push(pcm16.slice());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "Finalize" }));
        } catch {
          // Closing the socket still releases provider resources.
        }
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    this.closeSockets();
    this.pending.get("mic")?.splice(0);
    this.pending.get("speaker")?.splice(0);
  }

  private openChannel(channel: BrowserAudioChannel, url: string, protocols: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.createSocket(url, protocols);
      this.sockets.set(channel, socket);
      const timeout = setTimeout(() => finish(new Error("Live transcript connection timed out")), this.connectTimeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else {
          this.flush(channel, socket);
          resolve();
        }
      };
      socket.onopen = () => finish();
      socket.onerror = () => finish(new Error("Live transcript connection failed"));
      socket.onclose = () => {
        if (!settled && !this.stopped) finish(new Error("Live transcript connection closed before it was ready"));
        else if (!this.stopped) this.fail("The live transcript connection was interrupted");
      };
      socket.onmessage = (event) => this.handleMessage(channel, event.data);
    });
  }

  private flush(channel: BrowserAudioChannel, socket: WebSocket): void {
    const queue = this.pending.get(channel);
    if (!queue) return;
    for (const chunk of queue.splice(0)) {
      try {
        socket.send(chunk);
      } catch {
        this.fail("The live transcript connection was interrupted");
        return;
      }
    }
  }

  private handleMessage(channel: BrowserAudioChannel, data: unknown): void {
    let message: Record<string, unknown> | null;
    try {
      message = record(JSON.parse(typeof data === "string" ? data : String(data)));
    } catch {
      return;
    }
    if (message?.type === "Error") {
      const detail = record(message.description);
      this.fail(typeof detail?.message === "string" ? detail.message : "Live transcription failed");
      return;
    }
    if (message?.type !== "Results") return;
    const channelData = record(message.channel);
    const alternatives = channelData?.alternatives;
    const alternative = Array.isArray(alternatives) ? record(alternatives[0]) : null;
    const text = typeof alternative?.transcript === "string" ? alternative.transcript.trim() : "";
    if (!text) return;
    const words = alternative?.words;
    const firstWord = Array.isArray(words) ? record(words[0]) : null;
    const speaker = speakerFor(channel, firstWord?.speaker);
    const key = `${channel}:${speaker}`;
    let utteranceId = this.activeUtterances.get(key);
    if (utteranceId === undefined) {
      utteranceId = (this.nextUtterance.get(key) ?? 0) + 1;
      this.nextUtterance.set(key, utteranceId);
    }
    const isFinal = message.is_final === true;
    this.activeUtterances.set(key, utteranceId);
    const start = typeof message.start === "number" && Number.isFinite(message.start) ? Math.max(0, message.start) : 0;
    this.options.onEvent({ type: "transcript", channel, speaker, text, isFinal, utteranceId, offsetMs: Math.round(start * 1000) });
    if (isFinal) this.activeUtterances.delete(key);
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeSockets();
    this.options.onEvent({ type: "status", status: "unavailable", message });
  }

  private closeSockets(): void {
    for (const socket of this.sockets.values()) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Provider failures must not affect the locally persisted recording.
      }
    }
    this.sockets.clear();
  }
}
