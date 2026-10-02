import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { MeetCaptureController } from "../src/meet/meetCapture";
import { validSdp } from "../src/meet/directProtocol";
import { isMessageAllowed } from "../src/lib/senderPolicy";

const sendTab = vi.fn();
const tabStream = vi.fn((_options, callback) => callback("fallback-stream"));
const offer = "v=0\r\ntest-offer";
const answer = "v=0\r\ntest-answer";
beforeEach(() => {
  chromeMock.reset();
  tabStream.mockClear();
  Object.assign(chromeMock.tabs, { sendMessage: sendTab });
  Object.assign(chromeMock, { tabCapture: { getMediaStreamId: tabStream } });
  chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "https://meet.google.com/abc-defg-hij" });
  chromeMock.runtime.sendMessage.mockResolvedValue({ ok: true });
  sendTab.mockReset().mockImplementation(async (_tab, request) => ({ ok: true, available: true, documentKey: "document-1", ...(request.operation === "start" ? { sdp: offer } : {}) }));
});
afterEach(() => { delete (chromeMock.tabs as unknown as Record<string, unknown>).sendMessage; });

describe("direct Meet capture orchestration", () => {
  it("starts from a fresh Meet tab without invoking tabCapture", async () => {
    const capture = new MeetCaptureController();
    await capture.preflight(7);
    await capture.start(7, "meeting-1");
    expect(tabStream).not.toHaveBeenCalled();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "MEET_CAPTURE_START", tabId: 7, meetingId: "meeting-1", directOffer: offer });
    await capture.answerDirect("meeting-1", answer);
    expect(sendTab).toHaveBeenLastCalledWith(7, expect.objectContaining({ operation: "answer", documentKey: "document-1", sdp: answer }), { frameId: 0 });
  });

  it("falls back when a page predates the observer", async () => {
    sendTab.mockResolvedValue({ ok: true, available: false });
    await new MeetCaptureController().start(7, "meeting-1");
    expect(tabStream).toHaveBeenCalledOnce();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ streamId: "fallback-stream" }));
  });

  it("cleans up a failed relay before attempting the browser fallback", async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message) => message.directOffer ? { ok: false, error: "relay failed" } : { ok: true });
    const capture = new MeetCaptureController();
    await capture.start(7, "meeting-1");
    expect(tabStream).toHaveBeenCalledOnce();
    expect(sendTab).toHaveBeenCalledWith(7, expect.objectContaining({ operation: "stop", documentKey: "document-1" }), { frameId: 0 });
    expect(capture.isActive("meeting-1")).toBe(true);
  });

  it("restores the direct session so worker suspension does not orphan its source", async () => {
    await new MeetCaptureController().start(7, "meeting-1");
    const recovered = new MeetCaptureController();
    await recovered.restoreCaptures();
    await recovered.stop("meeting-1");
    expect(sendTab).toHaveBeenLastCalledWith(7, expect.objectContaining({ operation: "stop", documentKey: "document-1" }), { frameId: 0 });
  });

  it("rejects signaling outside the authorized meeting and after stop", async () => {
    const capture = new MeetCaptureController();
    await capture.start(7, "meeting-1");
    await expect(capture.answerDirect("other", answer)).rejects.toThrow("no longer active");
    await expect(capture.answerDirect("meeting-1", "x".repeat(100_000))).rejects.toThrow("no longer active");
    await capture.stop("meeting-1");
    await expect(capture.answerDirect("meeting-1", answer)).rejects.toThrow("no longer active");
    expect(isMessageAllowed("MEET_DIRECT_ANSWER", "offscreen")).toBe(true);
    for (const sender of ["meet-content-script", "extension-page", "untrusted"] as const) expect(isMessageAllowed("MEET_DIRECT_ANSWER", sender)).toBe(false);
    expect(validSdp({ sdp: answer })).toBe(false);
  });

  it("does not restart in fallback when Stop interrupts relay setup", async () => {
    let release: ((reply: object) => void) | undefined;
    sendTab.mockImplementation(async (_tab, request) => request.operation === "start"
      ? new Promise((resolve) => { release = resolve; })
      : { ok: true, available: true, documentKey: "document-1" });
    const capture = new MeetCaptureController();
    const start = capture.start(7, "meeting-1");
    const rejected = expect(start).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(release).toBeDefined());
    const stop = capture.stop("meeting-1");
    release!({ ok: true, sdp: offer });
    await Promise.all([rejected, stop]);
    expect(tabStream).not.toHaveBeenCalled();
    expect(capture.isActive("meeting-1")).toBe(false);
  });
});
