import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { MeetCaptureController, float32ToPcm16 } from "../src/meet/meetCapture";
import { MIC_PERMISSION_HINT } from "../src/meet/hints";

beforeEach(() => {
  chromeMock.reset();
  Object.assign(chromeMock, {
    tabs: { get: vi.fn(async () => ({ id: 7, url: "https://meet.google.com/abc-defg-hij" })) },
    offscreen: {
      Reason: { USER_MEDIA: "USER_MEDIA" },
      hasDocument: vi.fn(async () => false),
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
    },
  });
});

function grantStreamId(id: string | undefined, lastError?: string): void {
  Object.assign(chromeMock, {
    tabCapture: {
      getMediaStreamId: vi.fn((_options: unknown, callback: (streamId?: string) => void) => {
        chromeMock.runtime.lastError = lastError ? { message: lastError } : undefined;
        callback(id);
        chromeMock.runtime.lastError = undefined;
      }),
    },
  });
}

describe("Google Meet capture orchestration", () => {
  it("converts float audio to signed little-endian PCM16", () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-1, 0, 1])))).toEqual([0, 128, 0, 0, 255, 127]);
  });

  it("creates the offscreen media document and starts the requested Meet tab", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "meeting-1");

    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: "meet/offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
    }));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "MEET_CAPTURE_START",
      tabId: 7,
      meetingId: "meeting-1",
      streamId: "stream-abc",
    });
  });

  it("requests the tab stream id from the service worker, never the offscreen page", async () => {
    grantStreamId("stream-abc");
    await new MeetCaptureController(vi.fn()).start(7, "meeting-1");

    const tabCapture = (chromeMock as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } }).tabCapture;
    expect(tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 7 }, expect.any(Function));
  });

  it("fails before creating any offscreen document when Chrome has not granted the tab", async () => {
    grantStreamId(undefined, "Extension has not been invoked for the current page (see activeTab permission).");
    const controller = new MeetCaptureController(vi.fn());

    await expect(controller.start(7, "meeting-1")).rejects.toThrow("has not been invoked");
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
    expect(controller.isActive("meeting-1")).toBe(false);
  });

  it("closes the offscreen document when the capture cannot start, so the next try starts clean", async () => {
    grantStreamId("stream-abc");
    chromeMock.runtime.sendMessage.mockResolvedValue({ ok: false, error: "Requested device not found" });
    const controller = new MeetCaptureController(vi.fn());

    await expect(controller.start(7, "meeting-1")).rejects.toThrow("Requested device not found");
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
    expect(controller.isActive("meeting-1")).toBe(false);
  });

  it("reports a missing tabCapture API as an unsupported browser", async () => {
    Object.assign(chromeMock, { tabCapture: undefined });
    await expect(new MeetCaptureController(vi.fn()).start(7, "meeting-1")).rejects.toThrow("does not support");
  });

  it("stops the offscreen session and closes its document", async () => {
    const controller = new MeetCaptureController(vi.fn());
    await controller.stop("meeting-1");

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "MEET_CAPTURE_STOP", meetingId: "meeting-1" });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
  });

  it("tracks the Meet tab and tears down its capture when that tab disappears", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "meeting-1");

    await expect(controller.stopForTab(7)).resolves.toEqual(["meeting-1"]);
    expect(controller.isActive("meeting-1")).toBe(false);
    expect(chromeMock.runtime.sendMessage).toHaveBeenLastCalledWith({ type: "MEET_CAPTURE_STOP", meetingId: "meeting-1" });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
    await expect(controller.stopForTab(7)).resolves.toEqual([]);
  });

  it("clears tracking and closes the offscreen document when stop messaging fails", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "meeting-1");
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error("offscreen gone"));

    await expect(controller.stop("meeting-1")).rejects.toThrow("offscreen gone");
    expect(controller.isActive("meeting-1")).toBe(false);
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
  });

  it("reuses an existing offscreen document instead of creating a second one", async () => {
    grantStreamId("stream-abc");
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);

    await new MeetCaptureController(vi.fn()).start(7, "meeting-1");

    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("returns tab-owned meetings for recovery even when offscreen teardown rejects", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "meeting-1");
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error("offscreen gone"));

    await expect(controller.stopForTab(7)).resolves.toEqual(["meeting-1"]);
    expect(controller.isActive("meeting-1")).toBe(false);
  });

  it("refuses a non-Meet tab before asking for capture permission", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "https://zoom.us/j/123" });
    const controller = new MeetCaptureController(vi.fn());
    await expect(controller.start(7, "meeting-1")).rejects.toThrow("Google Meet tab");
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  describe("microphone permission", () => {
    function stubMicrophone(state: string | Error): void {
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: {
          query: vi.fn(async () => {
            if (state instanceof Error) throw state;
            return { state };
          }),
        },
      });
    }

    afterEach(() => {
      Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined });
    });

    it("sends the user to the one-time grant when the microphone is not yet allowed", async () => {
      grantStreamId("stream-abc");
      stubMicrophone("prompt");
      const controller = new MeetCaptureController(vi.fn());

      await expect(controller.start(7, "meeting-1")).rejects.toThrow(MIC_PERMISSION_HINT);
      const tabCapture = (chromeMock as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } }).tabCapture;
      expect(tabCapture.getMediaStreamId).not.toHaveBeenCalled();
      expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
    });

    it("also blocks a denied microphone", async () => {
      grantStreamId("stream-abc");
      stubMicrophone("denied");
      await expect(new MeetCaptureController(vi.fn()).start(7, "meeting-1")).rejects.toThrow(MIC_PERMISSION_HINT);
    });

    it("starts capture once the microphone is allowed", async () => {
      grantStreamId("stream-abc");
      stubMicrophone("granted");
      await new MeetCaptureController(vi.fn()).start(7, "meeting-1");
      expect(chromeMock.offscreen.createDocument).toHaveBeenCalled();
    });

  it("does not block capture when the permission state cannot be read", async () => {
      grantStreamId("stream-abc");
      stubMicrophone(new Error("unsupported"));
      await new MeetCaptureController(vi.fn()).start(7, "meeting-1");
      expect(chromeMock.offscreen.createDocument).toHaveBeenCalled();
    });
  });

  it("forwards independent mic and speaker chunks only for the active meeting", async () => {
    grantStreamId("stream-abc");
    const sendChunk = vi.fn();
    const controller = new MeetCaptureController(sendChunk);
    await controller.start(7, "meeting-1");

    const pcm = btoa(String.fromCharCode(1, 2, 3, 4));
    controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "meeting-1", channel: "mic", sampleRateHz: 48_000, pcm16Base64: pcm });
    controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "meeting-1", channel: "speaker", sampleRateHz: 48_000, pcm16Base64: pcm });
    controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "other", channel: "speaker", sampleRateHz: 48_000, pcm16Base64: pcm });

    expect(sendChunk).toHaveBeenCalledTimes(2);
    expect(sendChunk).toHaveBeenNthCalledWith(1, new Uint8Array([1, 2, 3, 4]), "meeting-1", "mic");
    expect(sendChunk).toHaveBeenNthCalledWith(2, new Uint8Array([1, 2, 3, 4]), "meeting-1", "speaker");
  });

  it("rejects malformed or mismatched Meet chunks before they reach the helper", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "meeting-1");
    const valid = btoa(String.fromCharCode(1, 2));

    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "meeting-1", channel: "mic", sampleRateHz: 44_100, pcm16Base64: valid })).toThrow("48 kHz");
    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "meeting-1", channel: "mic", sampleRateHz: 48_000, pcm16Base64: "%%%" })).toThrow("valid base64");
    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "meeting-1", channel: "mic", sampleRateHz: 48_000, pcm16Base64: btoa(String.fromCharCode(1)) })).toThrow("even-length");
  });
});
