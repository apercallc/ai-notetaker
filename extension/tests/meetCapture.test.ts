import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { MeetCaptureController, float32ToPcm16 } from "../src/meet/meetCapture";
import { DEFAULT_SETTINGS } from "../src/types";
import { saveSettings } from "../src/lib/storage";
import { MIC_PERMISSION_HINT } from "../src/meet/hints";

beforeEach(() => {
  chromeMock.reset();
  chromeMock.runtime.sendMessage.mockResolvedValue({ ok: true });
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
  it("remembers the widget owner after stop and service-worker restart", async () => {
    grantStreamId("stream-abc");
    const capture = new MeetCaptureController();
    await capture.start(7, "saved-call");
    await capture.stop("saved-call");
    expect(capture.isActiveForTab("saved-call", 7)).toBe(false);
    expect(capture.widgetTabId("saved-call")).toBe(7);
    const resumed = new MeetCaptureController();
    await resumed.restoreCaptures();
    expect(resumed.widgetTabId("saved-call")).toBe(7);
    expect(resumed.widgetTabId("unrelated-call")).toBeUndefined();
  });
  it("does not report a recording when the offscreen page never acknowledges start", async () => {
    grantStreamId("stream-abc");
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
    const controller = new MeetCaptureController();
    await expect(controller.start(7, "missing-page")).rejects.toThrow("could not start");
    expect(controller.isActive("missing-page")).toBe(false);
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
  });

  it("finishes capture when navigation leaves Meet even with the same call path", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController();
    await controller.start(7, "m1");
    await expect(controller.stopForTab(7, "https://example.com/abc-defg-hij")).resolves.toEqual(["m1"]);
  });
  it("converts float audio to signed little-endian PCM16", () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-1, 0, 1])))).toEqual([0, 128, 0, 0, 255, 127]);
  });

  it("creates the offscreen media document and starts the requested Meet tab", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: "meet/offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
    }));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "MEET_CAPTURE_START",
      tabId: 7,
      meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36",
      streamId: "stream-abc",
    });
  });

  it("keeps old provider keys out of new recorder capture", async () => {
    grantStreamId("stream-abc");
    await saveSettings({ ...DEFAULT_SETTINGS, transcriptionProvider: "deepgram", apiKeys: { deepgram: " dg-key " } });
    await new MeetCaptureController(vi.fn()).start(7, "meeting-live");
    const start = chromeMock.runtime.sendMessage.mock.calls.find(([message]) => message.type === "MEET_CAPTURE_START")?.[0];
    expect(start).toMatchObject({ type: "MEET_CAPTURE_START", meetingId: "meeting-live" });
    expect(start).not.toHaveProperty("liveDeepgramKey");
  });

  it("forwards the first chunk even when it arrives before the offscreen start reply", async () => {
    grantStreamId("stream-abc");
    const sendChunk = vi.fn();
    const controller = new MeetCaptureController(sendChunk);
    const pcm = btoa(String.fromCharCode(1, 2));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string; meetingId?: string }) => {
      if (message.type === "MEET_CAPTURE_START") {
        expect(controller.isActive("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).toBe(true);
        controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "speaker", sampleRateHz: 48_000, pcm16Base64: pcm });
      }
      return { ok: true };
    });

    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    expect(sendChunk).toHaveBeenCalledWith(new Uint8Array([1, 2]), "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", "speaker");
  });

  it("requests the tab stream id from the service worker, never the offscreen page", async () => {
    grantStreamId("stream-abc");
    await new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    const tabCapture = (chromeMock as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } }).tabCapture;
    expect(tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 7 }, expect.any(Function));
  });

  it("fails before creating any offscreen document when Chrome has not granted the tab", async () => {
    grantStreamId(undefined, "Extension has not been invoked for the current page (see activeTab permission).");
    const controller = new MeetCaptureController(vi.fn());

    await expect(controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow("has not been invoked");
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
    expect(controller.isActive("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).toBe(false);
  });

  it("closes the offscreen document when the capture cannot start, so the next try starts clean", async () => {
    grantStreamId("stream-abc");
    chromeMock.runtime.sendMessage.mockResolvedValue({ ok: false, error: "Requested device not found" });
    const controller = new MeetCaptureController(vi.fn());

    await expect(controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow("Requested device not found");
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
    expect(controller.isActive("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).toBe(false);
  });

  it("reports a missing tabCapture API as an unsupported browser", async () => {
    Object.assign(chromeMock, { tabCapture: undefined });
    await expect(new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow("does not support");
  });

  it("stops the offscreen session and closes its document", async () => {
    const controller = new MeetCaptureController(vi.fn());
    await controller.stop("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "MEET_CAPTURE_STOP", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36" });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
  });

  it("tracks the Meet tab and tears down its capture when that tab disappears", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    await expect(controller.stopForTab(7)).resolves.toEqual(["2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36"]);
    expect(controller.isActive("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).toBe(false);
    expect(chromeMock.runtime.sendMessage).toHaveBeenLastCalledWith({ type: "MEET_CAPTURE_STOP", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36" });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
    await expect(controller.stopForTab(7)).resolves.toEqual([]);
  });

  it("clears tracking and closes the offscreen document when stop messaging fails", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error("offscreen gone"));

    await expect(controller.stop("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow("offscreen gone");
    expect(controller.isActive("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).toBe(false);
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
  });

  it("reuses an existing offscreen document instead of creating a second one", async () => {
    grantStreamId("stream-abc");
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);

    await new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("returns tab-owned meetings for recovery even when offscreen teardown rejects", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
    chromeMock.runtime.sendMessage.mockRejectedValueOnce(new Error("offscreen gone"));

    await expect(controller.stopForTab(7)).resolves.toEqual(["2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36"]);
    expect(controller.isActive("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).toBe(false);
  });

  it("captures a Zoom browser tab and keeps same-origin navigation recording", async () => {
    grantStreamId("zoom-stream");
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "https://app.zoom.us/wc/123" });
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "MEET_CAPTURE_START", streamId: "zoom-stream" }));
    await expect(controller.stopForTab(7, "https://app.zoom.us/wc/456")).resolves.toEqual([]);
    await expect(controller.stopForTab(7, "https://example.com/")).resolves.toEqual(["2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36"]);
  });

  it("restores a Teams capture after a worker restart before handling navigation", async () => {
    grantStreamId("teams-stream");
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "https://teams.microsoft.com/v2/" });
    await new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
    const resumed = new MeetCaptureController(vi.fn());
    await resumed.restoreCaptures();
    await expect(resumed.stopForTab(7, "https://teams.microsoft.com/v2/call/123")).resolves.toEqual([]);
    await expect(resumed.stopForTab(7, "https://example.com/")).resolves.toEqual(["2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36"]);
  });

  it("refuses an insecure or browser-internal tab before asking for capture permission", async () => {
    grantStreamId("stream-abc");
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "http://example.com/call" });
    const controller = new MeetCaptureController(vi.fn());
    await expect(controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow("secure browser meeting tab");
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "chrome://newtab" });
    await expect(controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow("secure browser meeting tab");
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

      await expect(controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow(MIC_PERMISSION_HINT);
      const tabCapture = (chromeMock as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } }).tabCapture;
      expect(tabCapture.getMediaStreamId).not.toHaveBeenCalled();
      expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
    });

    it("also blocks a denied microphone", async () => {
      grantStreamId("stream-abc");
      stubMicrophone("denied");
      await expect(new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36")).rejects.toThrow(MIC_PERMISSION_HINT);
    });

    it("starts capture once the microphone is allowed", async () => {
      grantStreamId("stream-abc");
      stubMicrophone("granted");
      await new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
      expect(chromeMock.offscreen.createDocument).toHaveBeenCalled();
    });

  it("does not block capture when the permission state cannot be read", async () => {
      grantStreamId("stream-abc");
      stubMicrophone(new Error("unsupported"));
      await new MeetCaptureController(vi.fn()).start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
      expect(chromeMock.offscreen.createDocument).toHaveBeenCalled();
    });
  });

  it("forwards independent mic and speaker chunks only for the active meeting", async () => {
    grantStreamId("stream-abc");
    const sendChunk = vi.fn();
    const controller = new MeetCaptureController(sendChunk);
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");

    const pcm = btoa(String.fromCharCode(1, 2, 3, 4));
    controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "mic", sampleRateHz: 48_000, pcm16Base64: pcm });
    controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "speaker", sampleRateHz: 48_000, pcm16Base64: pcm });
    controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "other", channel: "speaker", sampleRateHz: 48_000, pcm16Base64: pcm });

    expect(sendChunk).toHaveBeenCalledTimes(2);
    expect(sendChunk).toHaveBeenNthCalledWith(1, new Uint8Array([1, 2, 3, 4]), "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", "mic");
    expect(sendChunk).toHaveBeenNthCalledWith(2, new Uint8Array([1, 2, 3, 4]), "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", "speaker");
  });

  it("rejects malformed or mismatched Meet chunks before they reach the helper", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
    const valid = btoa(String.fromCharCode(1, 2));

    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "mic", sampleRateHz: 44_100, pcm16Base64: valid })).toThrow("48 kHz");
    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "mic", sampleRateHz: 48_000, pcm16Base64: "%%%" })).toThrow("valid base64");
    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "mic", sampleRateHz: 48_000, pcm16Base64: btoa(String.fromCharCode(1)) })).toThrow("even-length");
  });

  it("rejects an unknown channel and a non-UUID meeting id", async () => {
    grantStreamId("stream-abc");
    const controller = new MeetCaptureController(vi.fn());
    await controller.start(7, "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36");
    const valid = btoa(String.fromCharCode(1, 2));
    expect(() => controller.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36", channel: "system" as never, sampleRateHz: 48_000, pcm16Base64: valid })).toThrow("channel is invalid");
    const loose = new MeetCaptureController(vi.fn());
    loose.recover("not-a-uuid", 7);
    expect(() => loose.forwardChunk({ type: "MEET_AUDIO_CHUNK", meetingId: "not-a-uuid", channel: "mic", sampleRateHz: 48_000, pcm16Base64: valid })).toThrow("meeting id is invalid");
  });
});
