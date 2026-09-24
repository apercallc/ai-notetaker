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
  type AudioProbeResult,
  type AudioStatus,
  type BrowserAudioChannel,
  type CaptureSource,
  type FlaggedMomentWire,
  type MeetingMode,
  type NotetakerSettings,
  type ProviderKind,
} from "../types";

const HOST_NAME = "com.ainotetaker.helper";
const TEST_PROVIDER_KEY_TIMEOUT_MS = 10_000;
const AUDIO_DIAGNOSTICS_TIMEOUT_MS = 8_000;
const MAX_BROWSER_AUDIO_CHUNK_BYTES = 64 * 1024;
const BROWSER_AUDIO_SAMPLE_RATE_HZ = 48_000;
const MIN_RECONNECT_BACKOFF_MS = 1_000;
const MAX_RECONNECT_BACKOFF_MS = 30_000;
const HELPER_RETRY_ALARM = "ai-notetaker-helper-retry";
/**
 * chrome.alarms clamps anything under 30s up to 30s, so the early steps of
 * the backoff schedule would be flattened if every retry went through an
 * alarm. Short delays use setTimeout (the service worker is still alive
 * that soon after a disconnect); longer ones use the alarm, which survives
 * the worker being suspended.
 */
const MIN_ALARM_DELAY_MS = 30_000;

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
export type HelperConnectionStatus = "connecting" | "connected" | "helper_not_found" | "disconnected" | "incompatible";

export class NativeMessagingClient {
  private port: chrome.runtime.Port | null = null;
  private connectPromise: Promise<void> | null = null;
  private listeners: Map<IncomingMessageType, Set<Listener<IncomingMessage>>> = new Map();
  private statusListeners: Set<Listener<HelperConnectionStatus>> = new Set();
  private currentStatus: HelperConnectionStatus | null = null;
  private reconnectBackoffMs = MIN_RECONNECT_BACKOFF_MS;

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    const connection = new Promise<void>((resolve) => {
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
      // A reconnect creates a new Port. Pass the instance through so a late
      // disconnect from an older port cannot tear down the newer connection.
      port.onDisconnect.addListener(() => this.handleDisconnect(port));
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
    this.connectPromise = connection;
    void connection.then(
      () => {
        if (this.connectPromise === connection) this.connectPromise = null;
      },
      () => {
        if (this.connectPromise === connection) this.connectPromise = null;
      },
    );
    return connection;
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

  private handleDisconnect(disconnectedPort?: chrome.runtime.Port): void {
    if (disconnectedPort && this.port !== disconnectedPort) return;
    this.port = null;
    const lastError = chrome.runtime.lastError;
    const hostMissing = /not found/i.test(lastError?.message ?? "");

    if (hostMissing) {
      this.handleHostMissing();
      return;
    }

    // An ordinary disconnect still needs a backoff, not an instant retry.
    // The common cause is "helper installed but not running": Chrome finds
    // the host manifest, spawns notetaker-nm-host, that shim can't reach the
    // tray app's socket and exits(1). Chrome reports an ordinary disconnect
    // (not "not found"), so reconnecting immediately spawned a fresh OS
    // process per disconnect as fast as Chrome would allow. Share the same
    // schedule as the not-found path; a real reconnect resets it in
    // handleMessage.
    this.setStatus("disconnected");
    this.scheduleReconnect();
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
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, MAX_RECONNECT_BACKOFF_MS);
    if (delay >= MIN_ALARM_DELAY_MS && chrome.alarms?.create) {
      // An alarm wakes a suspended MV3 service worker; setTimeout does not.
      void chrome.alarms.create(HELPER_RETRY_ALARM, { delayInMinutes: delay / 60_000 });
      return;
    }
    // Short delays (and non-Chrome test harnesses / older Chromium variants
    // with no chrome.alarms) use a plain timer, which chrome.alarms would
    // otherwise round up to its 30s floor.
    setTimeout(() => void this.connect(), delay);
  }

  retryFromAlarm(): void {
    void this.connect();
  }

  private handleMessage(raw: unknown): void {
    if (!isIncomingMessage(raw)) return;
    // Any real message proves the helper is genuinely there and
    // responsive — reset the backoff so a helper that gets installed (or
    // started) later doesn't stay throttled at a stale, longer delay.
    this.reconnectBackoffMs = MIN_RECONNECT_BACKOFF_MS;
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

  pushSettings(settings: Pick<NotetakerSettings, "transcriptionProvider" | "summarizationProvider" | "apiKeys" | "webapp" | "defaultMeetingMode" | "customVocabulary" | "customSummaryInstructions">): void {
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
      defaultMeetingMode: settings.defaultMeetingMode,
      customVocabulary: settings.customVocabulary,
      customSummaryInstructions: settings.customSummaryInstructions,
    });
  }

  startRecording(meetingId: string, meetingMode: MeetingMode, captureSource: CaptureSource = "desktop"): void {
    this.send({
      type: "start_recording",
      meetingId,
      meetingMode,
      ...(captureSource === "meet" ? { captureSource } : {}),
    });
  }

  sendAudioChunk(
    meetingId: string,
    channel: BrowserAudioChannel,
    pcm16: Uint8Array,
    sampleRateHz = BROWSER_AUDIO_SAMPLE_RATE_HZ,
  ): void {
    if (sampleRateHz !== BROWSER_AUDIO_SAMPLE_RATE_HZ) throw new Error("Meet capture must use 48 kHz audio");
    if (pcm16.byteLength === 0 || pcm16.byteLength > MAX_BROWSER_AUDIO_CHUNK_BYTES || pcm16.byteLength % 2 !== 0) {
      throw new Error("Meet audio chunks must be non-empty, even-length PCM16 data under 64 KiB");
    }
    let binary = "";
    for (const byte of pcm16) binary += String.fromCharCode(byte);
    this.send({
      type: "audio_chunk",
      meetingId,
      channel,
      sampleRateHz,
      pcm16Base64: btoa(binary),
    });
  }

  stopRecording(meetingId: string, flaggedMoments: FlaggedMomentWire[] = []): void {
    // The field is omitted when empty, so a helper that predates it sees the
    // same message as before.
    this.send({ type: "stop_recording", meetingId, ...(flaggedMoments.length > 0 ? { flaggedMoments } : {}) });
  }

  resumeRecording(meetingId: string): void {
    this.send({ type: "resume_recording", meetingId });
  }

  discardRecording(meetingId: string): void {
    this.send({ type: "discard_recording", meetingId });
  }

  deleteMeeting(meetingId: string): void {
    this.send({ type: "delete_meeting", meetingId });
  }

  getAudioPreflight(): Promise<AudioStatus> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const fallback: AudioStatus = {
        platform: "unknown",
        driver: "Desktop helper",
        driverInstalled: false,
        microphone: null,
        speaker: null,
        ready: false,
        guidance: "The helper did not respond. Install and start it, then check audio again.",
      };
      const handler = (message: Extract<IncomingMessage, { type: "audio_status" }>): void => {
        settle(message);
      };
      const settle = (result: AudioStatus): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        this.off("audio_status", handler);
        resolve(result);
      };
      this.on("audio_status", handler);
      try {
        this.send({ type: "audio_preflight" });
      } catch {
        settle(fallback);
        return;
      }
      timeoutId = setTimeout(() => settle(fallback), AUDIO_DIAGNOSTICS_TIMEOUT_MS);
    });
  }

  runAudioProbe(): Promise<AudioProbeResult> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const fallback: AudioProbeResult = {
        micFrames: 0,
        speakerFrames: 0,
        passed: false,
        message: "The helper did not respond. Install and start it, then try again.",
      };
      const handler = (message: Extract<IncomingMessage, { type: "audio_probe_result" }>): void => {
        settle(message);
      };
      const settle = (result: AudioProbeResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        this.off("audio_probe_result", handler);
        resolve(result);
      };
      this.on("audio_probe_result", handler);
      try {
        this.send({ type: "audio_probe" });
      } catch {
        settle(fallback);
        return;
      }
      timeoutId = setTimeout(() => settle(fallback), AUDIO_DIAGNOSTICS_TIMEOUT_MS);
    });
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
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const handler = (msg: Extract<IncomingMessage, { type: "provider_key_test_result" }>): void => {
        if (msg.provider !== provider || settled) return;
        settle({ valid: msg.valid, message: msg.message });
      };
      const settle = (result: { valid: boolean; message: string }): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
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
      timeoutId = setTimeout(
        () => settle({ valid: false, message: "Timed out waiting for the helper to respond. Is it running?" }),
        TEST_PROVIDER_KEY_TIMEOUT_MS,
      );
    });
  }
}
