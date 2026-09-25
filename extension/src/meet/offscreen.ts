import { isFromExtensionWorker } from "../lib/senderPolicy";
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

/** DOMException (what getUserMedia rejects with) is not always an Error across realms. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Meet capture failed";
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
  const nodes = captureNodes;
  captureNodes = [];
  // Flush while the streams are still live; the resulting chunks go out before the STOP reply does.
  await Promise.all(nodes.map((node) => flush(node)));
  await Promise.allSettled([...pendingWrites]);
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
    const write: Promise<void> = chrome.runtime.sendMessage({
      type: "MEET_AUDIO_CHUNK",
      meetingId,
      channel,
      sampleRateHz: SAMPLE_RATE_HZ,
      pcm16Base64: toBase64(pcm16),
      ...(captureTabId === undefined ? {} : { tabId: captureTabId }),
    }).then((response: { error?: string } | undefined) => {
      if (response?.error) throw new Error(response.error);
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
