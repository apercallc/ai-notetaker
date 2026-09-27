import { isFromExtensionWorker } from "../lib/senderPolicy";
import { getSettings } from "../lib/storage";
import { DeepgramLiveTranscriber, type DeepgramLiveEvent } from "./deepgramLiveTranscriber";
import { float32ToPcm16 } from "./meetCapture";
import type { BrowserAudioChannel } from "../types";

const SAMPLE_RATE_HZ = 48_000;
/**
 * 0.5 s per message (48 kB of PCM16, ~64 kB as base64). The service worker
 * rejects chunks over 64 KiB of raw PCM, so this is close to the largest size
 * the receiver accepts; it cuts the message rate from ~23/s (4096-sample
 * ScriptProcessor buffers on two channels) to 4/s.
 *
 * Chunks still travel as base64: chrome.runtime.sendMessage / Port messages
 * are JSON-serialized, so ArrayBuffers cannot be transferred (or even cloned)
 * to the service worker. The transfer here is worklet -> this page, which is
 * zero-copy.
 */
const CHUNK_SAMPLES = 24_000;
const WORKLET_URL = "meet/captureWorklet.js";
const FLUSH_TIMEOUT_MS = 500;

let streams: MediaStream[] = [];
let context: AudioContext | null = null;
let captureNodes: AudioWorkletNode[] = [];
/** Sent with every chunk so a restarted worker can re-attach the capture to its tab. */
let captureTabId: number | undefined;
const pendingWrites = new Set<Promise<void>>();
const pendingLiveMessages = new Set<Promise<void>>();
const pendingLiveAudio = new Map<BrowserAudioChannel, Uint8Array[]>([["mic", []], ["speaker", []]]);
const MAX_PENDING_CHUNKS_PER_CHANNEL = 8;
let liveTranscriber: DeepgramLiveTranscriber | null = null;
let captureGeneration = 0;
let stoppingGeneration: number | null = null;

/** DOMException (what getUserMedia rejects with) is not always an Error across realms. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Meet capture failed";
}

/**
 * "Receiving end does not exist" and port-closed errors are transient here:
 * the MV3 service worker can be killed and restarted between two audio
 * chunks, and while it is down sendMessage rejects exactly this way. Losing
 * the whole capture over one such blip — when every chunk is already
 * durable-first in the worker once it comes back — is wrong; retry a few
 * times with a short backoff and only give up once the worker stays
 * unreachable for a while.
 */
function isTransientWorkerRestart(reason: unknown): boolean {
  const message = errorMessage(reason);
  return /receiving end does not exist|message port closed|The message port closed/i.test(message);
}

const CHUNK_SEND_ATTEMPTS = 4;
const CHUNK_SEND_BACKOFF_MS = 250;

/** Sends one chunk with bounded retries for transient worker-restart errors. */
async function sendChunkWithRetry(payload: object): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = (await chrome.runtime.sendMessage(payload)) as { error?: string } | undefined;
      if (response?.error) throw new Error(response.error);
      return;
    } catch (reason) {
      if (attempt >= CHUNK_SEND_ATTEMPTS || !isTransientWorkerRestart(reason)) throw reason;
      await new Promise((resolve) => setTimeout(resolve, CHUNK_SEND_BACKOFF_MS * attempt));
    }
  }
}

function reportLiveEvent(meetingId: string, generation: number, event: DeepgramLiveEvent): void {
  if (generation !== captureGeneration && generation !== stoppingGeneration) return;
  let message: object;
  if (event.type === "status") {
    message = { type: "MEET_LIVE_TRANSCRIPT_STATUS", meetingId, status: event.status };
  } else {
    const { type: _eventType, ...update } = event;
    message = { type: "MEET_LIVE_TRANSCRIPT_UPDATE", meetingId, ...update };
  }
  const task = chrome.runtime.sendMessage(message).then(() => undefined).catch(() => undefined);
  pendingLiveMessages.add(task);
  void task.finally(() => pendingLiveMessages.delete(task));
}

async function startLiveTranscription(meetingId: string, generation: number): Promise<void> {
  try {
    const settings = await getSettings();
    if (generation !== captureGeneration) return;
    const apiKey = settings.apiKeys.deepgram?.trim() ?? "";
    if (settings.processingMode.kind !== "local_byok" || settings.transcriptionProvider !== "deepgram" || !apiKey) {
      reportLiveEvent(meetingId, generation, { type: "status", status: "not_supported" });
      return;
    }
    const transcriber = new DeepgramLiveTranscriber({ onEvent: (event) => reportLiveEvent(meetingId, generation, event) });
    liveTranscriber = transcriber;
    const connected = transcriber.connect({ kind: "apiKey", token: apiKey });
    for (const channel of ["mic", "speaker"] as const) {
      const queue = pendingLiveAudio.get(channel);
      for (const chunk of queue?.splice(0) ?? []) transcriber.send(channel, chunk);
    }
    await connected;
  } catch {
    if (generation === captureGeneration && !liveTranscriber) {
      reportLiveEvent(meetingId, generation, { type: "status", status: "unavailable" });
    }
  }
}

function queueOrSendLiveAudio(channel: BrowserAudioChannel, pcm16: Uint8Array): void {
  if (liveTranscriber) {
    liveTranscriber.send(channel, pcm16);
    return;
  }
  const queue = pendingLiveAudio.get(channel);
  if (queue && queue.length < MAX_PENDING_CHUNKS_PER_CHANNEL) queue.push(pcm16.slice());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Slices keep String.fromCharCode under the engine's argument-count limit.
  for (let offset = 0; offset < bytes.length; offset += 0x2000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x2000));
  return btoa(binary);
}

/** Asks the worklet for its partial buffer so the tail of the call is not lost, then waits for the ack. */
function flush(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    const previous = node.port.onmessage;
    node.port.onmessage = (event) => {
      if ((event.data as { type?: string } | null)?.type === "flushed") {
        clearTimeout(timer);
        resolve();
        return;
      }
      previous?.call(node.port, event);
    };
    node.port.postMessage({ type: "flush" });
  });
}

async function stop(): Promise<void> {
  stoppingGeneration = captureGeneration;
  captureGeneration += 1;
  const nodes = captureNodes;
  captureNodes = [];
  // Flush while the streams are still live; the resulting chunks go out before the STOP reply does.
  await Promise.all(nodes.map((node) => flush(node)));
  await Promise.allSettled([...pendingWrites]);
  const transcriber = liveTranscriber;
  await transcriber?.stop();
  await Promise.allSettled([...pendingLiveMessages]);
  if (liveTranscriber === transcriber) liveTranscriber = null;
  for (const queue of pendingLiveAudio.values()) queue.splice(0);
  stoppingGeneration = null;
  nodes.forEach((node) => {
    node.port.onmessage = null;
    node.disconnect();
  });
  streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  streams = [];
  if (context) await context.close().catch(() => {});
  context = null;
}

function attachCapture(stream: MediaStream, channel: BrowserAudioChannel, meetingId: string): void {
  if (!context) throw new Error("Meet audio context is not ready");
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "meet-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { chunkSamples: CHUNK_SAMPLES },
  });
  node.port.onmessage = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const pcm16 = float32ToPcm16(new Float32Array(event.data));
    const write: Promise<void> = sendChunkWithRetry({
      type: "MEET_AUDIO_CHUNK",
      meetingId,
      channel,
      sampleRateHz: SAMPLE_RATE_HZ,
      pcm16Base64: toBase64(pcm16),
      ...(captureTabId === undefined ? {} : { tabId: captureTabId }),
    }).then(() => {
      // Provider audio leaves the extension only after the worker acknowledges its local durable write.
      queueOrSendLiveAudio(channel, pcm16);
    }).catch(() => {
      void chrome.runtime.sendMessage({
        type: "MEET_CAPTURE_ERROR",
        meetingId,
        message: "Notetaker lost its connection to the call audio. What was recorded so far is safe; start notes again.",
      }).catch(() => undefined);
      void stop();
    });
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  };
  source.connect(node);
  // tabCapture mutes the tab while it is captured; reconnecting this source
  // to the destination preserves ordinary Meet listening for the user.
  if (channel === "speaker") source.connect(context.destination);
  // The worklet only runs while its output reaches the destination; it writes no output, so the sink is silent anyway.
  const silentSink = context.createGain();
  silentSink.gain.value = 0;
  node.connect(silentSink);
  silentSink.connect(context.destination);
  captureNodes.push(node);
}

async function start(capturedStreamId: string, meetingId: string, tabId?: number): Promise<void> {
  await stop();
  captureTabId = tabId;
  context = new AudioContext({ sampleRate: SAMPLE_RATE_HZ });
  if (context.sampleRate !== SAMPLE_RATE_HZ) throw new Error("The browser audio device could not run at 48 kHz");
  await context.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_URL));

  // Each stream is tracked the moment it exists: a captured tab stays locked
  // ("Cannot capture a tab with an active stream") until its tracks stop, so a
  // failure on any later step must release everything acquired so far.
  const speaker = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: capturedStreamId } } as MediaTrackConstraints,
  });
  streams = [speaker];
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: SAMPLE_RATE_HZ } });
  streams = [speaker, mic];
  attachCapture(speaker, "speaker", meetingId);
  attachCapture(mic, "mic", meetingId);
  void startLiveTranscription(meetingId, captureGeneration);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Runtime messages reach every extension context, including the Meet content
  // script; only the service worker may drive capture.
  if (!isFromExtensionWorker(sender, { extensionId: chrome.runtime.id, extensionBaseUrl: chrome.runtime.getURL("") })) return false;
  const value = message as { type?: string; streamId?: string; meetingId?: string; tabId?: number };
  if (value.type === "MEET_CAPTURE_START" && typeof value.streamId === "string" && typeof value.meetingId === "string") {
    void start(value.streamId, value.meetingId, typeof value.tabId === "number" ? value.tabId : undefined).then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      void stop();
      sendResponse({ ok: false, error: errorMessage(error) });
    });
    return true;
  }
  if (value.type === "MEET_CAPTURE_STOP") {
    void stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
