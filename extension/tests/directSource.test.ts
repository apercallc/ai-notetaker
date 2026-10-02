import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectMeetSource } from "../src/meet/directSource";

function remotePeer(direction: RTCRtpTransceiverDirection = "recvonly") {
  const track = { kind: "audio", readyState: "live", stop: vi.fn() };
  const peer = Object.assign(new EventTarget(), {
    connectionState: "connected", getTransceivers: () => [{ currentDirection: direction, receiver: { track } }],
  });
  return { track, peer: peer as unknown as RTCPeerConnection };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("direct remote-track discovery", () => {
  it("does not mistake local send-only or ended tracks for remote call audio", () => {
    const source = new DirectMeetSource(class {} as typeof RTCPeerConnection);
    source.observe(remotePeer("sendonly").peer);
    expect(source.available()).toBe(false);
    const remote = remotePeer();
    source.observe(remote.peer);
    expect(source.available()).toBe(true);
    remote.track.readyState = "ended";
    expect(source.available()).toBe(false);
  });

  it("adds and removes participants without stopping their tracks or renegotiating", async () => {
    vi.useFakeTimers();
    const generatedTrack = { stop: vi.fn() };
    const connect = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
    vi.stubGlobal("AudioContext", class {
      state = "running";
      resume = async () => {};
      close = vi.fn(async () => {});
      createMediaStreamDestination = () => ({ stream: { getAudioTracks: () => [generatedTrack], getTracks: () => [generatedTrack] } });
      createMediaStreamSource = () => ({ connect, disconnect });
    });
    const addTransceiver = vi.fn();
    const close = vi.fn();
    class Peer extends EventTarget {
      connectionState = "connected";
      iceGatheringState = "complete";
      localDescription = { sdp: "v=0\r\nfixture" };
      createDataChannel = () => ({ readyState: "open", bufferedAmount: 0, send: vi.fn() });
      addTransceiver = addTransceiver;
      createOffer = async () => this.localDescription;
      setLocalDescription = async () => {};
      close = close;
    }
    const source = new DirectMeetSource(Peer as unknown as typeof RTCPeerConnection);
    const first = remotePeer();
    source.observe(first.peer);
    await source.start("session-1");
    expect(addTransceiver).toHaveBeenCalledOnce();
    expect(addTransceiver).toHaveBeenCalledWith(generatedTrack, expect.objectContaining({ direction: "sendonly" }));
    const second = remotePeer();
    source.observe(second.peer);
    second.peer.dispatchEvent(new Event("track"));
    expect(connect).toHaveBeenCalledTimes(2);
    first.track.readyState = "ended";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disconnect).toHaveBeenCalledOnce();
    await source.stop("stale-session");
    expect(close).not.toHaveBeenCalled();
    await source.stop("session-1");
    expect(close).toHaveBeenCalledOnce();
    expect(generatedTrack.stop).toHaveBeenCalledOnce();
    expect(first.track.stop).not.toHaveBeenCalled();
    expect(second.track.stop).not.toHaveBeenCalled();
    expect(addTransceiver).toHaveBeenCalledOnce();
  });
});
