import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_CAPTURE_HINT, CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT, describeCaptureFailure, finishMeetCaptureForTab, handleMeetCommand, startMeetRecording, stopMeetRecording } from "../src/meet/session";
import type { BackgroundController } from "../src/lib/backgroundController";
import type { MeetCaptureController } from "../src/meet/meetCapture";
import { chromeMock } from "./setup";

function fakes(active: { id: string } | null = null) {
  const controller = {
    startRecording: vi.fn(async () => "m1"),
    failRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async (_id: string): Promise<void> => undefined),
    addBookmark: vi.fn(async () => true),
    reportStartFailure: vi.fn(),
    abortStart: vi.fn(async () => undefined),
    getState: vi.fn(() => ({ activeMeeting: active })),
  };
  const capture = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    isActive: vi.fn(() => true),
    preflight: vi.fn(async () => undefined),
    stopForTab: vi.fn(async () => [] as string[]),
  };
  return { controller, capture, asTypes: () => [controller as unknown as BackgroundController, capture as unknown as MeetCaptureController] as const };
}

const MEET_TAB = { id: 9, url: "https://meet.google.com/abc-defg-hij", title: "Roadmap - Google Meet" };

beforeEach(() => {
  vi.restoreAllMocks();
  chromeMock.reset();
});

describe("describeCaptureFailure", () => {
  it("turns Chrome's activeTab refusal into an actionable instruction", () => {
    expect(describeCaptureFailure(new Error("Extension has not been invoked for the current page (see activeTab permission)."))).toBe(CAPTURE_PERMISSION_HINT);
    expect(describeCaptureFailure(new Error("Chrome pages cannot be captured. (see activeTab permission)"))).toBe(CAPTURE_PERMISSION_HINT);
  });

  it("names a tab that is still captured instead of blaming the missing click", () => {
    expect(describeCaptureFailure(new Error("Cannot capture a tab with an active stream."))).toBe(ACTIVE_CAPTURE_HINT);
  });

  it("recognises microphone permission failures from the offscreen page", () => {
    expect(describeCaptureFailure(new Error("Permission denied"))).toBe(MIC_PERMISSION_HINT);
    expect(describeCaptureFailure(new Error("Permission dismissed"))).toBe(MIC_PERMISSION_HINT);
    expect(describeCaptureFailure(new Error(MIC_PERMISSION_HINT))).toBe(MIC_PERMISSION_HINT);
  });

  it("passes other messages through and has a default", () => {
    expect(describeCaptureFailure(new Error("Select an active Google Meet tab for browser capture."))).toBe("Select an active Google Meet tab for browser capture.");
    expect(describeCaptureFailure("weird")).toBe("Google Meet capture could not start.");
  });
});

describe("startMeetRecording", () => {
  it("starts the meeting with the meet source and then the tab capture", async () => {
    const { controller, capture, asTypes } = fakes();
    const [c, k] = asTypes();

    const id = await startMeetRecording(c, k, { tabId: 9, meetingMode: "sales", titleHint: "Roadmap" });

    expect(id).toBe("m1");
    expect(controller.startRecording).toHaveBeenCalledWith("sales", "meet", "Roadmap");
    expect(capture.start).toHaveBeenCalledWith(9, "m1");
  });

  it("discovers the active Meet tab for a toolbar start", async () => {
    const { controller, capture, asTypes } = fakes();
    chromeMock.tabs.query.mockResolvedValue([MEET_TAB]);
    const [c, k] = asTypes();

    expect(await startMeetRecording(c, k, {})).toBe("m1");
    expect(controller.startRecording).toHaveBeenCalledWith(undefined, "meet", "Roadmap");
    expect(capture.start).toHaveBeenCalledWith(9, "m1");
  });

  it("returns empty without capturing when the meeting could not start", async () => {
    const { controller, capture, asTypes } = fakes();
    controller.startRecording.mockResolvedValue("");
    const [c, k] = asTypes();

    expect(await startMeetRecording(c, k, { tabId: 9 })).toBe("");
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("reports the failure without creating a meeting when there is no tab to capture", async () => {
    const { controller, capture, asTypes } = fakes();
    const [c, k] = asTypes();

    expect(await startMeetRecording(c, k, { tabId: undefined })).toBe("");
    expect(controller.reportStartFailure).toHaveBeenCalledWith("Open the Google Meet call in this tab first, then start notes.");
    expect(controller.startRecording).not.toHaveBeenCalled();
    expect(controller.failRecording).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("reports a preflight refusal before any meeting record exists", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.preflight.mockRejectedValue(new Error("Extension has not been invoked for the current page"));
    const [c, k] = asTypes();

    expect(await startMeetRecording(c, k, { tabId: 9 })).toBe("");
    expect(controller.reportStartFailure).toHaveBeenCalledWith(CAPTURE_PERMISSION_HINT);
    expect(controller.startRecording).not.toHaveBeenCalled();
    expect(controller.abortStart).not.toHaveBeenCalled();
  });

  it("aborts a start whose capture fails after the meeting was created, leaving no failed meeting", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.start.mockRejectedValue(new Error("Extension has not been invoked for the current page"));
    const [c, k] = asTypes();

    expect(await startMeetRecording(c, k, { tabId: 9 })).toBe("");
    expect(controller.abortStart).toHaveBeenCalledWith("m1", CAPTURE_PERMISSION_HINT);
    expect(controller.failRecording).not.toHaveBeenCalled();
  });
});

describe("stopMeetRecording", () => {
  it("stops capture, then always finalizes the meeting even if capture teardown throws", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.stop.mockRejectedValue(new Error("offscreen gone"));
    const [c, k] = asTypes();

    await expect(stopMeetRecording(c, k, "m1")).rejects.toThrow("offscreen gone");
    expect(controller.stopRecording).toHaveBeenCalledWith("m1");
  });

  it("skips capture teardown for a desktop recording", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.isActive.mockReturnValue(false);
    const [c, k] = asTypes();

    await stopMeetRecording(c, k, "m1");
    expect(capture.stop).not.toHaveBeenCalled();
    expect(controller.stopRecording).toHaveBeenCalledWith("m1");
  });
});

describe("finishMeetCaptureForTab", () => {
  it("finalizes the meetings a closed tab was recording, instead of failing them", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.stopForTab.mockResolvedValue(["m1", "m2"]);
    const [c, k] = asTypes();

    await finishMeetCaptureForTab(c, k, 9);

    expect(capture.stopForTab).toHaveBeenCalledWith(9, undefined);
    expect(controller.stopRecording).toHaveBeenCalledWith("m1");
    expect(controller.stopRecording).toHaveBeenCalledWith("m2");
    expect(controller.failRecording).not.toHaveBeenCalled();
  });

  it("passes the next URL along so a same-call navigation can be ignored", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.stopForTab.mockResolvedValue([]);
    const [c, k] = asTypes();

    await finishMeetCaptureForTab(c, k, 9, "https://meet.google.com/abc-defg-hij?cls=10");

    expect(capture.stopForTab).toHaveBeenCalledWith(9, "https://meet.google.com/abc-defg-hij?cls=10");
    expect(controller.stopRecording).not.toHaveBeenCalled();
  });

  it("keeps finalizing the other meetings when one teardown fails", async () => {
    const { controller, capture, asTypes } = fakes();
    capture.stopForTab.mockResolvedValue(["m1", "m2"]);
    controller.stopRecording.mockImplementation(async (id: string) => {
      if (id === "m1") throw new Error("gone");
    });
    const [c, k] = asTypes();

    await expect(finishMeetCaptureForTab(c, k, 9)).resolves.toBeUndefined();
    expect(controller.stopRecording).toHaveBeenCalledWith("m2");
  });
});

describe("handleMeetCommand", () => {
  it("starts recording on a Meet tab, naming it from the tab title", async () => {
    const { controller, capture, asTypes } = fakes();
    const [c, k] = asTypes();

    await handleMeetCommand("toggle-recording", MEET_TAB, c, k);

    expect(controller.startRecording).toHaveBeenCalledWith(undefined, "meet", "Roadmap");
    expect(capture.start).toHaveBeenCalledWith(9, "m1");
  });

  it("stops the active recording, wherever the shortcut is pressed", async () => {
    const { controller, asTypes } = fakes({ id: "live" });
    const [c, k] = asTypes();

    await handleMeetCommand("toggle-recording", { id: 3, url: "https://example.com/" }, c, k);

    expect(controller.stopRecording).toHaveBeenCalledWith("live");
    expect(controller.startRecording).not.toHaveBeenCalled();
  });

  it("ignores the start shortcut outside a Meet tab instead of leaving a failed meeting behind", async () => {
    const { controller, asTypes } = fakes();
    const [c, k] = asTypes();

    await handleMeetCommand("toggle-recording", { id: 3, url: "https://example.com/" }, c, k);
    await handleMeetCommand("toggle-recording", undefined, c, k);

    expect(controller.startRecording).not.toHaveBeenCalled();
  });

  it("flags a moment only while recording", async () => {
    const idle = fakes();
    await handleMeetCommand("add-bookmark", MEET_TAB, ...idle.asTypes());
    expect(idle.controller.addBookmark).not.toHaveBeenCalled();

    const live = fakes({ id: "live" });
    await handleMeetCommand("add-bookmark", MEET_TAB, ...live.asTypes());
    expect(live.controller.addBookmark).toHaveBeenCalledWith("live");
  });

  it("ignores unknown commands", async () => {
    const { controller, asTypes } = fakes();
    await handleMeetCommand("something-else", MEET_TAB, ...asTypes());
    expect(controller.startRecording).not.toHaveBeenCalled();
  });
});
