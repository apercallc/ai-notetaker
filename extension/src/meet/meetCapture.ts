import type { BrowserAudioChannel } from "../types";
import { MIC_PERMISSION_HINT } from "./hints";

export interface MeetAudioChunk {
  type: "MEET_AUDIO_CHUNK";
  meetingId: string;
  channel: BrowserAudioChannel;
  sampleRateHz: number;
  pcm16Base64: string;
}

const MEET_HOST = /(^|\.)meet\.google\.com$/i;
const SAMPLE_RATE_HZ = 48_000;

/** Converts Web Audio's normalized float samples to little-endian PCM16. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const pcm16 = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm16.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, value, true);
  }
  return pcm16;
}

function sendMessage<T = unknown>(message: unknown): Promise<T | undefined> {
  const result = chrome.runtime.sendMessage(message);
  return result && typeof (result as Promise<unknown>).then === "function" ? (result as Promise<T>) : Promise.resolve(undefined);
}

/**
 * Offscreen documents can only use chrome.runtime, so the stream id has to be
 * requested here, in the service worker, and handed to the offscreen page.
 * Chrome refuses unless the user has invoked the extension on that tab.
 */
function tabStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture?.getMediaStreamId) {
      reject(new Error("This browser does not support the Google Meet capture mode."));
      return;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Google Meet tab audio could not be captured"));
        return;
      }
      resolve(id);
    });
  });
}

/**
 * Offscreen documents cannot show a permission prompt, so the microphone must
 * already be allowed for the extension. Checking here lets us send the user to
 * the one-time grant page instead of failing deep inside the capture start.
 */
async function assertMicrophoneAllowed(): Promise<void> {
  if (!navigator.permissions?.query) return;
  let state: PermissionState;
  try {
    state = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return;
  }
  if (state !== "granted") throw new Error(MIC_PERMISSION_HINT);
}

export class MeetCaptureController {
  private readonly activeMeetings = new Set<string>();

  constructor(private readonly sendChunk: (chunk: Uint8Array, meetingId: string, channel: BrowserAudioChannel) => void = () => {}) {}

  async start(tabId: number, meetingId: string): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ? new URL(tab.url) : null;
    if (!url || !MEET_HOST.test(url.hostname)) throw new Error("Select an active Google Meet tab for browser capture.");
    if (!chrome.offscreen) throw new Error("This browser does not support the Google Meet capture mode.");

    await assertMicrophoneAllowed();
    // Ask Chrome next: if the user has not invoked the extension on this tab
    // this fails fast, before any offscreen document exists.
    const streamId = await tabStreamId(tabId);
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "meet/offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Capture the Google Meet microphone and remote audio as two local note-taking channels.",
      });
    }
    const response = await sendMessage<{ ok?: boolean; error?: string }>({ type: "MEET_CAPTURE_START", tabId, meetingId, streamId });
    if (response?.ok === false) {
      // Leave no half-started capture behind; the next attempt starts clean.
      await chrome.offscreen.closeDocument().catch(() => {});
      throw new Error(response.error ?? "Google Meet capture could not start.");
    }
    this.activeMeetings.add(meetingId);
  }

  async stop(meetingId: string): Promise<void> {
    if (!chrome.offscreen) return;
    await sendMessage({ type: "MEET_CAPTURE_STOP", meetingId });
    this.activeMeetings.delete(meetingId);
    await chrome.offscreen.closeDocument().catch(() => {});
  }

  isActive(meetingId: string): boolean {
    return this.activeMeetings.has(meetingId);
  }

  forwardChunk(message: MeetAudioChunk): void {
    if (!this.activeMeetings.has(message.meetingId)) return;
    if (message.sampleRateHz !== SAMPLE_RATE_HZ) throw new Error("Meet capture must use 48 kHz audio");
    let binary: string;
    try {
      binary = atob(message.pcm16Base64);
    } catch {
      throw new Error("Meet audio chunk is not valid base64");
    }
    if (binary.length === 0 || binary.length > 64 * 1024 || binary.length % 2 !== 0) {
      throw new Error("Meet audio chunks must be non-empty, even-length PCM16 data under 64 KiB");
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    this.sendChunk(bytes, message.meetingId, message.channel);
  }
}
