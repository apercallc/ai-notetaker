import { DirectMeetSource } from "../meet/directSource";
import { DIRECT_BRIDGE, validSdp, validSession } from "../meet/directProtocol";

// A MAIN-world observer must be installed before Meet creates its connections.
// It exposes no extension APIs and never asks for microphone permission.
const NativePeer = window.RTCPeerConnection;
if (NativePeer) {
  const source = new DirectMeetSource(NativePeer);
  window.RTCPeerConnection = new Proxy(NativePeer, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      source.observe(peer);
      return peer;
    },
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.bridge !== DIRECT_BRIDGE || data.direction !== "request" || !validSession(data.requestId)) return;
    if (!["probe", "start", "answer", "stop"].includes(data.operation)) return;
    if (data.operation !== "probe" && !validSession(data.session)) return;
    if (data.operation === "answer" && !validSdp(data.sdp)) return;
    const respond = (value: object) => window.postMessage({ bridge: DIRECT_BRIDGE, direction: "reply", requestId: data.requestId, ...value }, location.origin);
    void (async () => {
      switch (data.operation) {
        case "probe": return { ok: true, available: source.available() };
        case "start": return { ok: true, sdp: await source.start(data.session) };
        case "answer": await source.answer(data.session, data.sdp); return { ok: true };
        case "stop": await source.stop(data.session); return { ok: true };
      }
    })().then((result) => respond(result ?? { ok: false }), () => respond({ ok: false }));
  });
}
