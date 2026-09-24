import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { MeetCaptureController, float32ToPcm16 } from "../src/meet/meetCapture";

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

describe("Google Meet capture orchestration", () => {
  it("converts float audio to signed little-endian PCM16", () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-1, 0, 1])))).toEqual([0, 128, 0, 0, 255, 127]);
  });

  it("creates the offscreen media document and starts the requested Meet tab", async () => {
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
    });
  });

  it("stops the offscreen session and closes its document", async () => {
    const controller = new MeetCaptureController(vi.fn());
    await controller.stop("meeting-1");

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "MEET_CAPTURE_STOP", meetingId: "meeting-1" });
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalled();
  });

  it("refuses a non-Meet tab before asking for capture permission", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 7, url: "https://zoom.us/j/123" });
    const controller = new MeetCaptureController(vi.fn());
    await expect(controller.start(7, "meeting-1")).rejects.toThrow("Google Meet tab");
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });
});
