import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAutoRecordAttempt, maybeAutoStartMeetRecording, resetAutoRecordTrackingForTests } from "../src/lib/autoRecord";
import { DEFAULT_SETTINGS } from "../src/types";

const CALL_URL = "https://meet.google.com/abc-defg-hij";
const OTHER_CALL_URL = "https://meet.google.com/xyz-klmn-pqr";
const HOME_URL = "https://meet.google.com/";

function deps(overrides: Partial<Parameters<typeof maybeAutoStartMeetRecording>[2]> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({ autoRecordOnMeetJoin: true, onboardingComplete: true, consentDisclosureAcknowledged: true }),
    isRecordingActive: vi.fn().mockReturnValue(false),
    startMeetRecording: vi.fn().mockResolvedValue("meeting-1"),
    ...overrides,
  };
}

beforeEach(() => {
  resetAutoRecordTrackingForTests();
});

describe("maybeAutoStartMeetRecording", () => {
  it("defaults auto-record on while keeping disclosure and share off and opening notes on", () => {
    expect(DEFAULT_SETTINGS.autoRecordOnMeetJoin).toBe(true);
    expect(DEFAULT_SETTINGS.meetDisclosureNotice).toBe(false);
    expect(DEFAULT_SETTINGS.autoShareNotesWithAttendees).toBe(false);
    expect(DEFAULT_SETTINGS.openNotesWhenReady).toBe(true);
  });

  it("attempts a start when a tab lands on a call URL and the setting is on", async () => {
    const d = deps();
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(true);
    expect(d.startMeetRecording).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("does nothing on the Meet home page or non-Meet URLs", async () => {
    const d = deps();
    await expect(maybeAutoStartMeetRecording(7, HOME_URL, d)).resolves.toBe(false);
    await expect(maybeAutoStartMeetRecording(7, "https://example.com/", d)).resolves.toBe(false);
    expect(d.startMeetRecording).not.toHaveBeenCalled();
  });

  it("respects the opt-in: off means no attempt", async () => {
    const d = deps({ getSettings: vi.fn().mockResolvedValue({ autoRecordOnMeetJoin: false, onboardingComplete: true, consentDisclosureAcknowledged: true }) });
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(false);
    expect(d.startMeetRecording).not.toHaveBeenCalled();
  });

  it("never double-starts for the same call, but a new call in the same tab is eligible again", async () => {
    const d = deps();
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(true);
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(false);
    clearAutoRecordAttempt(7, OTHER_CALL_URL);
    await expect(maybeAutoStartMeetRecording(7, OTHER_CALL_URL, d)).resolves.toBe(true);
  });

  it("does not attempt while another recording is live", async () => {
    const d = deps({ isRecordingActive: vi.fn().mockReturnValue(true) });
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(false);
  });

  it("does not attempt before onboarding/consent are complete", async () => {
    const d = deps({ getSettings: vi.fn().mockResolvedValue({ autoRecordOnMeetJoin: true, onboardingComplete: false, consentDisclosureAcknowledged: true }) });
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(false);
  });

  it("swallows a rejected auto-start (Chrome's invocation gate is expected)", async () => {
    const d = deps({ startMeetRecording: vi.fn().mockRejectedValue(new Error("Extension has not been invoked")) });
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(false);
  });
});

describe("clearAutoRecordAttempt", () => {
  it("re-arms a tab that leaves its call entirely", async () => {
    const d = deps();
    await maybeAutoStartMeetRecording(7, CALL_URL, d);
    clearAutoRecordAttempt(7, "https://example.com/");
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(true);
  });

  it("keeps the attempt marker through same-call URL changes", async () => {
    const d = deps();
    await maybeAutoStartMeetRecording(7, CALL_URL, d);
    clearAutoRecordAttempt(7, `${CALL_URL}?hs=1`);
    await expect(maybeAutoStartMeetRecording(7, CALL_URL, d)).resolves.toBe(false);
  });
});
