/** Signaling only. Never put credentials, microphone audio, or provider requests on this bridge. */
export const DIRECT_BRIDGE = "ai-notetaker-meet-audio-v1";
export const MAX_SDP_LENGTH = 64 * 1024;
export type DirectOperation = "probe" | "start" | "answer" | "stop";
export interface DirectRequest {
  type: "MEET_DIRECT_CONTROL";
  operation: DirectOperation;
  session?: string;
  documentKey?: string;
  sdp?: string;
}
export interface DirectReply {
  ok: boolean;
  available?: boolean;
  documentKey?: string;
  sdp?: string;
  error?: string;
}
export function validSdp(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("v=0") && value.length <= MAX_SDP_LENGTH;
}
export function validSession(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}
export async function bounded<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Meet audio connection timed out.")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export async function gatherIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  let listener: () => void = () => {};
  try {
    await bounded(new Promise<void>((resolve) => {
      listener = () => { if (peer.iceGatheringState === "complete") resolve(); };
      peer.addEventListener("icegatheringstatechange", listener);
      listener();
    }), 4_000);
  } finally { peer.removeEventListener("icegatheringstatechange", listener); }
}
