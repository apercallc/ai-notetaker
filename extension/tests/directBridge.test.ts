import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DIRECT_BRIDGE } from "../src/meet/directProtocol";

type Listener = (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
const worker = { id: "fake-extension-id", url: "chrome-extension://fake-extension-id/background.js" };
beforeEach(() => { chromeMock.reset(); vi.restoreAllMocks(); vi.resetModules(); });
describe("isolated direct audio bridge", () => {
  it("rejects page senders and stale-document commands", async () => {
    await import("../src/content/directBridge");
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]![0] as Listener;
    const reply = vi.fn();
    expect(listener({ type: "MEET_DIRECT_CONTROL", operation: "probe" }, { id: worker.id, url: "https://meet.google.com/abc-defg-hij", tab: { id: 7 } }, reply)).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    listener({ type: "MEET_DIRECT_CONTROL", operation: "stop", session: "session-1", documentKey: "old-document" }, worker, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("copies only bounded signaling from same-window same-origin replies", async () => {
    await import("../src/content/directBridge");
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]![0] as Listener;
    vi.spyOn(window, "postMessage").mockImplementation((request) => {
      queueMicrotask(() => {
        const data = { bridge: DIRECT_BRIDGE, direction: "reply", requestId: request.requestId, ok: true, available: true, sdp: "v=0" + "x".repeat(100_000), apiKey: "must-not-forward" };
        window.dispatchEvent(new MessageEvent("message", { source: window, origin: location.origin, data }));
      });
    });
    const result = await new Promise(resolve => { listener({ type: "MEET_DIRECT_CONTROL", operation: "probe" }, worker, resolve); });
    expect(result).toEqual({ ok: true, available: true, documentKey: expect.any(String) });
  });
});
