/**
 * Native Messaging client — implements docs/native-messaging-protocol.md
 * exactly. If you're changing message shapes, update that doc first, since
 * the helper (a separate package) is built against it as the contract.
 *
 * MV3 service workers are killed after ~30s idle, so this client cannot
 * assume a persistent connection — it reconnects on disconnect, and the
 * helper (which owns the pipeline) is the source of truth for in-progress
 * recording state, not this client's in-memory state.
 */
import { getPairingToken, savePairingToken } from "./storage";
import {
  isIncomingMessage,
  type IncomingMessage,
  type NotetakerSettings,
  type ProviderKind,
} from "../types";

const HOST_NAME = "com.ainotetaker.helper";
const TEST_PROVIDER_KEY_TIMEOUT_MS = 10_000;

type Listener<T> = (message: T) => void;
type IncomingMessageType = IncomingMessage["type"];

export class NativeMessagingClient {
  private port: chrome.runtime.Port | null = null;
  private listeners: Map<IncomingMessageType, Set<Listener<IncomingMessage>>> = new Map();

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.port = chrome.runtime.connectNative(HOST_NAME);
      this.port.onMessage.addListener((raw: unknown) => this.handleMessage(raw));
      this.port.onDisconnect.addListener(() => this.handleDisconnect());
      void this.sendHello().then(resolve);
    });
  }

  private async sendHello(): Promise<void> {
    const pairingToken = await getPairingToken();
    this.send({ type: "hello", pairingToken });
  }

  private handleDisconnect(): void {
    this.port = null;
    // The helper may have restarted or the OS may have torn down the pipe;
    // reconnect so the popup/service-worker can resume receiving updates.
    void this.connect();
  }

  private handleMessage(raw: unknown): void {
    if (!isIncomingMessage(raw)) return;
    if (raw.type === "paired") {
      void savePairingToken(raw.pairingToken);
    }
    const handlers = this.listeners.get(raw.type);
    if (!handlers) return;
    for (const handler of handlers) handler(raw);
  }

  on<T extends IncomingMessageType>(
    type: T,
    handler: Listener<Extract<IncomingMessage, { type: T }>>,
  ): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler as Listener<IncomingMessage>);
  }

  off<T extends IncomingMessageType>(
    type: T,
    handler: Listener<Extract<IncomingMessage, { type: T }>>,
  ): void {
    this.listeners.get(type)?.delete(handler as Listener<IncomingMessage>);
  }

  private send(message: unknown): void {
    if (!this.port) {
      throw new Error("NativeMessagingClient: not connected. Call connect() first.");
    }
    this.port.postMessage(message);
  }

  pushSettings(settings: Pick<NotetakerSettings, "transcriptionProvider" | "summarizationProvider" | "apiKeys" | "webapp">): void {
    this.send({
      type: "settings",
      transcriptionProvider: settings.transcriptionProvider,
      summarizationProvider: settings.summarizationProvider,
      apiKeys: settings.apiKeys,
      webapp: settings.webapp,
    });
  }

  startRecording(meetingId: string): void {
    this.send({ type: "start_recording", meetingId });
  }

  stopRecording(meetingId: string): void {
    this.send({ type: "stop_recording", meetingId });
  }

  resumeRecording(meetingId: string): void {
    this.send({ type: "resume_recording", meetingId });
  }

  discardRecording(meetingId: string): void {
    this.send({ type: "discard_recording", meetingId });
  }

  /**
   * Routes "test this key" through the helper instead of calling the
   * provider's API directly from the extension — see extension/CLAUDE.md
   * ("Do not call transcription/LLM provider APIs directly from the
   * extension") and docs/native-messaging-protocol.md. Resolves via a
   * one-shot listener correlated on `provider` (the settings page only
   * ever has one test in flight per provider), with a timeout so a lost
   * reply (e.g. helper not running) doesn't hang the UI forever.
   */
  testProviderKey(provider: ProviderKind, key: string): Promise<{ valid: boolean; message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const handler = (msg: Extract<IncomingMessage, { type: "provider_key_test_result" }>): void => {
        if (msg.provider !== provider || settled) return;
        settle({ valid: msg.valid, message: msg.message });
      };
      const settle = (result: { valid: boolean; message: string }): void => {
        if (settled) return;
        settled = true;
        this.off("provider_key_test_result", handler);
        resolve(result);
      };
      this.on("provider_key_test_result", handler);
      this.send({ type: "test_provider_key", provider, key });
      setTimeout(
        () => settle({ valid: false, message: "Timed out waiting for the helper to respond. Is it running?" }),
        TEST_PROVIDER_KEY_TIMEOUT_MS,
      );
    });
  }
}
