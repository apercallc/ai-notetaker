import { bounded, gatherIce, validSdp } from "./directProtocol";

/** Extension-owned, receive-only local relay. No mic track is ever attached. */
export class DirectAudioReceiver {
  private peer = new RTCPeerConnection({ iceServers: [] });
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastStatus = Date.now();
  private lastConnected = Date.now();
  private closed = false;
  private warned = false;
  private failed = false;
  private playback: HTMLAudioElement | null = null;

  constructor(private readonly failure: () => void, private readonly warning: () => void) {}

  async connect(offer: string, answer: (sdp: string) => Promise<void>): Promise<MediaStream> {
    if (!validSdp(offer)) throw new Error("Invalid Meet audio offer.");
    let stream: MediaStream | undefined;
    let ready: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => { ready = resolve; });
    const check = () => {
      if (stream && this.peer.connectionState === "connected") ready?.();
    };
    this.peer.ontrack = ({ track }) => {
      if (track.kind !== "audio" || stream) return;
      stream = new MediaStream([track]);
      check();
    };
    this.peer.onconnectionstatechange = check;
    this.peer.ondatachannel = ({ channel }) => {
      if (channel.label !== "capture-status") { channel.close(); return; }
      channel.onmessage = ({ data }) => {
        if (typeof data !== "string" || data.length > 200) return;
        try {
          const value = JSON.parse(data) as { tracks?: unknown; running?: unknown };
          if (typeof value.tracks !== "number" || !Number.isInteger(value.tracks) || value.tracks < 0 || value.tracks > 1000 || typeof value.running !== "boolean") return;
          this.lastStatus = Date.now();
          if (!value.running) { this.fail(); return; }
          if (value.tracks === 0 && !this.warned) this.warning();
          this.warned = value.tracks === 0;
        } catch { /* Page data never becomes an extension command. */ }
      };
    };
    try {
      await this.peer.setRemoteDescription({ type: "offer", sdp: offer });
      // Reject extra media and make every transceiver receive-only. In particular,
      // a forged page offer can never cause the extension to transmit its mic.
      const transceivers = this.peer.getTransceivers();
      if (transceivers.length !== 1 || transceivers[0]?.receiver.track.kind !== "audio") throw new Error("Expected one remote audio channel.");
      transceivers[0].direction = "recvonly";
      await this.peer.setLocalDescription(await this.peer.createAnswer());
      await gatherIce(this.peer);
      const sdp = this.peer.localDescription?.sdp;
      if (!validSdp(sdp)) throw new Error("Invalid Meet audio answer.");
      await answer(sdp);
      await bounded(connected, 6_000);
      if (this.closed || !stream) throw new Error("Meet audio connection was closed.");
      // Chromium needs an active media-element consumer to drive remote RTP
      // audio decoding. It stays muted: Meet already plays the call itself.
      this.playback = new Audio();
      this.playback.muted = true;
      this.playback.srcObject = stream;
      await bounded(this.playback.play(), 2_000);
      this.lastStatus = this.lastConnected = Date.now();
      this.timer = setInterval(() => {
        if (this.peer.connectionState === "connected") this.lastConnected = Date.now();
        if (Date.now() - this.lastStatus > 10_000 || Date.now() - this.lastConnected > 4_000 || this.peer.connectionState === "failed" || this.peer.connectionState === "closed") this.fail();
      }, 1_000);
      return stream;
    } catch (error) { this.close(); throw error; }
  }

  private fail(): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.failure();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.peer.onconnectionstatechange = null;
    this.peer.close();
    this.playback?.pause();
    if (this.playback) this.playback.srcObject = null;
    this.playback = null;
  }
}
