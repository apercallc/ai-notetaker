import { isFromExtensionWorker } from "../lib/senderPolicy";
import { bounded, DIRECT_BRIDGE, validSdp, validSession, type DirectReply, type DirectRequest } from "../meet/directProtocol";

// Isolated-world document identity prevents commands for an old document from
// controlling a new call after navigation. It is not a secret from the page.
const documentKey = crypto.randomUUID();
let busy = false;
async function requestPage(request: DirectRequest): Promise<DirectReply> {
  if (busy) return { ok: false, error: "Meet audio is already connecting." };
  busy = true;
  const requestId = crypto.randomUUID();
  let listener: (event: MessageEvent) => void = () => {};
  try {
    return await bounded(new Promise<DirectReply>((resolve) => {
      listener = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.bridge !== DIRECT_BRIDGE || data.direction !== "reply" || data.requestId !== requestId) return;
        // Page replies are untrusted. Copy only the bounded signaling fields.
        resolve({ ok: data.ok === true, available: data.available === true,
          ...(validSdp(data.sdp) ? { sdp: data.sdp } : {}), documentKey });
      };
      window.addEventListener("message", listener);
      window.postMessage({ bridge: DIRECT_BRIDGE, direction: "request", requestId,
        operation: request.operation, session: request.session, sdp: request.sdp }, location.origin);
    }), request.operation === "probe" ? 800 : 6_000);
  } catch { return { ok: false, error: "Direct Meet audio is unavailable." }; }
  finally { window.removeEventListener("message", listener); busy = false; }
}

chrome.runtime.onMessage.addListener((request: DirectRequest, sender, reply) => {
  if (request?.type !== "MEET_DIRECT_CONTROL" || !isFromExtensionWorker(sender, {
    extensionId: chrome.runtime.id, extensionBaseUrl: chrome.runtime.getURL(""),
  })) return false;
  if (!["probe", "start", "answer", "stop"].includes(request.operation)) return false;
  if (request.operation !== "probe" && (request.documentKey !== documentKey || !validSession(request.session))) {
    reply({ ok: false, error: "The Meet page changed. Start recording again." });
    return false;
  }
  if (request.operation === "answer" && !validSdp(request.sdp)) return false;
  void requestPage(request).then(reply);
  return true;
});
