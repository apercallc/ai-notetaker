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
const MIN_NOT_FOUND_BACKOFF_MS = 1_000;
const MAX_NOT_FOUND_BACKOFF_MS = 30_000;
const HELPER_RETRY_ALARM = "ai-notetaker-helper-retry";

type Listener<T> = (message: T) => void;
type IncomingMessageType = IncomingMessage["type"];

/**
 * "connecting"/"connected"/"disconnected" describe the ordinary lifecycle.
 * "helper_not_found" is distinct: it means Chrome couldn't locate the
 * native messaging host at all (no registered manifest for this OS —
 * i.e., the desktop helper was never installed, or its installer didn't
 * register it), not a transient hiccup. The UI uses this to show an
 * actionable "install the helper" state instead of silently retrying
 * forever.
 */
export type HelperConnectionStatus = "connecting" | "connected" | "helper_not_found" | "disconnected";

export class NativeMessagingClient {
  private port: chrome.runtime.Port | null = null;
  private listeners: Map<IncomingMessageType, Set<Listener<IncomingMessage>>> = new Map();
  private statusListeners: Set<Listener<HelperConnectionStatus>> = new Set();
  private currentStatus: HelperConnectionStatus | null = null;
  private notFoundBackoffMs = MIN_NOT_FOUND_BACKOFF_MS;

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.setStatus("connecting");
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch {
        // Chrome throws synchronously from connectNative for an
        // unregistered host — same meaning as the not-found disconnect
        // below, except no port was ever created so no onDisconnect
        // listener will ever fire. Route it through the shared not-found
        // path (status + backoff) and resolve, so init() and GET_STATE
        // never wedge on a helper that isn't installed.
        this.handleHostMissing();
        resolve();
        return;
      }
      this.port = port;
      port.onMessage.addListener((raw: unknown) => this.handleMessage(raw));
      port.onDisconnect.addListener(() => this.handleDisconnect());
      // If the helper dies between connect and hello, handleDisconnect has
      // already nulled this.port, so sendHello() rejects when it gets to
      // send() — resolve on either outcome for the same reason as above:
      // the connection *attempt* is over, and status listeners carry the
      // real state. A pending connect() promise is what the background
      // worker awaits before it can answer GET_STATE, so it must settle
      // exactly when the helper is missing, not hang. Resolve with
      // undefined either way — the error reason itself is not a result.
      void this.sendHello().then(
        () => resolve(),
        () => resolve(),
      );
    });
  }

  onStatusChange(handler: Listener<HelperConnectionStatus>): void {
    this.statusListeners.add(handler);
  }

  private setStatus(status: HelperConnectionStatus): void {
    // Status is "connected" on every incoming message, so without this
    // check every transcript segment during a live meeting would re-fire
    // listeners (and in the controller, re-broadcast HELPER_STATUS and
    // re-push settings) — listeners hear changes, not echoes.
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    for (const handler of this.statusListeners) handler(status);
  }

  private async sendHello(): Promise<void> {
    const pairingToken = await getPairingToken();
    this.send({ type: "hello", pairingToken });
  }

  private handleDisconnect(): void {
    this.port = null;
    const lastError = chrome.runtime.lastError;
    const hostMissing = /not found/i.test(lastError?.message ?? "");

    if (hostMissing) {
      this.handleHostMissing();
      return;
    }

    // An ordinary disconnect (helper restarted, OS tore down the pipe) is
    // expected to succeed again immediately — the helper (which owns the
    // pipeline) is the source of truth for in-progress recording state,
    // not this client's in-memory state, so reconnecting fast here is safe.
    this.setStatus("disconnected");
    void this.connect();
  }

  /**
   * The shared "Chrome couldn't locate a registered host manifest" path.
   * Retrying instantly against a host that is definitionally not
   * registered would hot-loop forever burning CPU for no benefit —
   * back off exponentially instead, capped at 30s, and let the UI
   * surface an actionable state via onStatusChange.
   */
  private handleHostMissing(): void {
    this.setStatus("helper_not_found");
    const delay = this.notFoundBackoffMs;
    this.notFoundBackoffMs = Math.min(this.notFoundBackoffMs * 2, MAX_NOT_FOUND_BACKOFF_MS);
    if (chrome.alarms?.create) {
      void chrome.alarms.create(HELPER_RETRY_ALARM, { delayInMinutes: delay / 60_000 });
    } else {
      // The fallback keeps the client usable in non-Chrome test harnesses and
      // older Chromium variants; production MV3 uses the alarm above so a
      // suspended service worker is woken for the retry.
      setTimeout(() => void this.connect(), delay);
    }
  }

  retryFromAlarm(): void {
    void this.connect();
  }

  private handleMessage(raw: unknown): void {
    if (!isIncomingMessage(raw)) return;
    // Any real message proves the helper is genuinely there and
    // responsive — reset the not-found backoff so a helper that gets
    // installed later doesn't stay throttled at a stale, longer delay.
    this.notFoundBackoffMs = MIN_NOT_FOUND_BACKOFF_MS;
    this.setStatus("connected");
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
    // State sync, not a one-shot command. The helper holds settings in
    // memory only for its process lifetime and the controller re-pushes
    // whenever the connection is (re)established, so dropping the push
    // while there is no port is safe — sending into a null port would
    // throw, which would reject init() and wedge GET_STATE exactly in the
    // helper-missing case this client reports via onStatusChange.
    if (!this.port) return;
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
      try {
        this.send({ type: "test_provider_key", provider, key });
      } catch {
        settle({ valid: false, message: "The helper is not connected. Install and start it, then try again." });
        return;
      }
      setTimeout(
        () => settle({ valid: false, message: "Timed out waiting for the helper to respond. Is it running?" }),
        TEST_PROVIDER_KEY_TIMEOUT_MS,
      );
    });
  }
}
