import { isFromExtensionWorker } from "../lib/senderPolicy";
import { float32ToPcm16 } from "./meetCapture";
import type { BrowserAudioChannel } from "../types";

const SAMPLE_RATE_HZ = 48_000;
const PROCESSOR_BUFFER_SIZE = 4096;

let streams: MediaStream[] = [];
let context: AudioContext | null = null;
let processors: ScriptProcessorNode[] = [];

/** DOMException (what getUserMedia rejects with) is not always an Error across realms. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Meet capture failed";
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function stop(): Promise<void> {
  processors.forEach((processor) => processor.disconnect());
  processors = [];
  streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  streams = [];
  if (context) await context.close().catch(() => {});
  context = null;
}

function attachProcessor(stream: MediaStream, channel: BrowserAudioChannel, meetingId: string): void {
  if (!context) throw new Error("Meet audio context is not ready");
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 2, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const sampleCount = input.length;
    const mixed = new Float32Array(sampleCount);
    for (let channelIndex = 0; channelIndex < input.numberOfChannels; channelIndex += 1) {
      const data = input.getChannelData(channelIndex);
      for (let index = 0; index < sampleCount; index += 1) mixed[index] = (mixed[index] ?? 0) + (data[index] ?? 0) / input.numberOfChannels;
    }
    const pcm16 = float32ToPcm16(mixed);
    void chrome.runtime.sendMessage({
      type: "MEET_AUDIO_CHUNK",
      meetingId,
      channel,
      sampleRateHz: SAMPLE_RATE_HZ,
      pcm16Base64: toBase64(pcm16),
    }).catch(() => stop());
  };
  source.connect(processor);
  // tabCapture mutes the tab while it is captured; reconnecting this source
  // to the destination preserves ordinary Meet listening for the user.
  if (channel === "speaker") source.connect(context.destination);
  const silentSink = context.createGain();
  silentSink.gain.value = 0;
  processor.connect(silentSink);
  silentSink.connect(context.destination);
  processors.push(processor);
}

async function start(capturedStreamId: string, meetingId: string): Promise<void> {
  await stop();
  context = new AudioContext({ sampleRate: SAMPLE_RATE_HZ });
  if (context.sampleRate !== SAMPLE_RATE_HZ) throw new Error("The browser audio device could not run at 48 kHz");

  // Each stream is tracked the moment it exists: a captured tab stays locked
  // ("Cannot capture a tab with an active stream") until its tracks stop, so a
  // failure on any later step must release everything acquired so far.
  const speaker = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: capturedStreamId } } as MediaTrackConstraints,
  });
  streams = [speaker];
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: SAMPLE_RATE_HZ } });
  streams = [speaker, mic];
  attachProcessor(speaker, "speaker", meetingId);
  attachProcessor(mic, "mic", meetingId);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Runtime messages reach every extension context, including the Meet content
  // script; only the service worker may drive capture.
  if (!isFromExtensionWorker(sender, { extensionId: chrome.runtime.id, extensionBaseUrl: chrome.runtime.getURL("") })) return false;
  const value = message as { type?: string; streamId?: string; meetingId?: string };
  if (value.type === "MEET_CAPTURE_START" && typeof value.streamId === "string" && typeof value.meetingId === "string") {
    void start(value.streamId, value.meetingId).then(() => sendResponse({ ok: true })).catch((error: unknown) => {
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
