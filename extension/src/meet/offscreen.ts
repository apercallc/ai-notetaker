import { float32ToPcm16 } from "./meetCapture";
import type { BrowserAudioChannel } from "../types";

const SAMPLE_RATE_HZ = 48_000;
const PROCESSOR_BUFFER_SIZE = 4096;

let streams: MediaStream[] = [];
let context: AudioContext | null = null;
let processors: ScriptProcessorNode[] = [];
let activeMeetingId: string | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function streamId(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: currentTabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Google Meet tab audio could not be captured"));
        return;
      }
      resolve(id);
    });
  });
}

let currentTabId = 0;

async function stop(): Promise<void> {
  processors.forEach((processor) => processor.disconnect());
  processors = [];
  streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  streams = [];
  if (context) await context.close().catch(() => {});
  context = null;
  activeMeetingId = null;
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

async function start(tabId: number, meetingId: string): Promise<void> {
  await stop();
  currentTabId = tabId;
  activeMeetingId = meetingId;
  context = new AudioContext({ sampleRate: SAMPLE_RATE_HZ });
  if (context.sampleRate !== SAMPLE_RATE_HZ) throw new Error("The browser audio device could not run at 48 kHz");

  const capturedStreamId = await streamId();
  const speaker = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: capturedStreamId } } as MediaTrackConstraints,
  });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: SAMPLE_RATE_HZ } });
  streams = [speaker, mic];
  attachProcessor(speaker, "speaker", meetingId);
  attachProcessor(mic, "mic", meetingId);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const value = message as { type?: string; tabId?: number; meetingId?: string };
  if (value.type === "MEET_CAPTURE_START" && typeof value.tabId === "number" && typeof value.meetingId === "string") {
    void start(value.tabId, value.meetingId).then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      void stop();
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Meet capture failed" });
    });
    return true;
  }
  if (value.type === "MEET_CAPTURE_STOP") {
    void stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
