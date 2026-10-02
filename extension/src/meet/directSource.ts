import { bounded, gatherIce, validSdp } from "./directProtocol";

/** Runs in Meet's MAIN world. Observe only remote receivers, never senders/microphones. */
export class DirectMeetSource {
  private readonly peers = new Set<RTCPeerConnection>();
  private readonly sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>();
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private relay: RTCPeerConnection | null = null;
  private status: RTCDataChannel | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private session: string | null = null;
  private connectedAt = 0;
  private starting = false;

  constructor(private readonly Peer: typeof RTCPeerConnection) {}

  observe(peer: RTCPeerConnection): void {
    // Closed peer objects must not accumulate over a long-lived Meet tab.
    if (peer.connectionState === "closed") return;
    this.peers.add(peer);
    const changed = () => {
      if (peer.connectionState === "closed") {
        this.peers.delete(peer);
        peer.removeEventListener("connectionstatechange", changed);
        peer.removeEventListener("track", changed);
      }
      this.refresh();
    };
    peer.addEventListener("connectionstatechange", changed);
    peer.addEventListener("track", changed);
  }

  private tracks(): Set<MediaStreamTrack> {
    const tracks = new Set<MediaStreamTrack>();
    for (const peer of this.peers) {
      if (peer.connectionState === "closed" || peer.connectionState === "failed") continue;
      for (const transceiver of peer.getTransceivers()) {
        if (transceiver.currentDirection !== "recvonly" && transceiver.currentDirection !== "sendrecv") continue;
        const { track } = transceiver.receiver;
        if (track.kind === "audio" && track.readyState === "live") tracks.add(track);
      }
    }
    return tracks;
  }

  available(): boolean { return this.tracks().size > 0; }

  private refresh(): void {
    if (!this.context || !this.destination) return;
    const tracks = this.tracks();
    for (const [track, source] of this.sources) {
      if (!tracks.has(track)) { source.disconnect(); this.sources.delete(track); }
    }
    for (const track of tracks) {
      if (this.sources.has(track)) continue;
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      source.connect(this.destination);
      this.sources.set(track, source);
    }
    // This channel reports liveness, never extension commands or credentials.
    if (this.status?.readyState === "open" && this.status.bufferedAmount < 1024) {
      this.status.send(JSON.stringify({ tracks: tracks.size, running: this.context.state === "running" }));
    }
  }

  async start(session: string): Promise<string> {
    if (this.starting || this.session) throw new Error("Meet audio is already connected.");
    if (!this.available()) throw new Error("Meet remote audio is not available yet.");
    this.starting = true;
    this.session = session;
    try {
      const context = new AudioContext({ sampleRate: 48_000 });
      this.context = context;
      await bounded(context.resume(), 1_000);
      if (this.session !== session || context.state !== "running") throw new Error("Meet audio could not resume.");
      this.destination = context.createMediaStreamDestination();
      const relay = new this.Peer({ iceServers: [] });
      this.relay = relay;
      this.status = relay.createDataChannel("capture-status");
      // One stable, send-only mixed remote channel. Participant changes do not
      // renegotiate the relay, and Meet's own playback stays untouched.
      for (const track of this.destination.stream.getAudioTracks()) relay.addTransceiver(track, { direction: "sendonly", streams: [this.destination.stream] });
      this.refresh();
      this.connectedAt = Date.now();
      this.timer = setInterval(() => {
        if (relay.connectionState === "connected") this.connectedAt = Date.now();
        if (Date.now() - this.connectedAt > 12_000 || relay.connectionState === "closed" || relay.connectionState === "failed") {
          void this.stop(session);
        } else this.refresh();
      }, 1_000);
      await relay.setLocalDescription(await relay.createOffer());
      await gatherIce(relay);
      const sdp = relay.localDescription?.sdp;
      if (this.session !== session || !validSdp(sdp)) throw new Error("Meet audio offer was invalid.");
      return sdp;
    } catch (error) { await this.stop(session); throw error; }
    finally { this.starting = false; }
  }

  async answer(session: string, sdp: string): Promise<void> {
    if (this.session !== session || !this.relay || !validSdp(sdp)) throw new Error("Meet audio session changed.");
    await this.relay.setRemoteDescription({ type: "answer", sdp });
  }

  async stop(session: string): Promise<void> {
    if (this.session !== session) return;
    this.session = null;
    clearInterval(this.timer);
    this.relay?.close();
    this.relay = null;
    this.status = null;
    for (const source of this.sources.values()) source.disconnect();
    this.sources.clear();
    // Only stop our generated mix. Never stop or mutate Meet's receiver tracks.
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.destination = null;
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => {});
  }
}
