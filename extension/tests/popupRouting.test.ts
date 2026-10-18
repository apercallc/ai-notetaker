import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

const state = { activeMeeting: null, recoverableMeeting: null, helperStatus: "helper_not_found", helperInfo: null };

async function loadPopup(tab: { id: number; url: string } | null, settings = { ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true }, stateOverride: Record<string, unknown> = {}, pendingTabId?: number, pendingExtra: Record<string, unknown> = {}): Promise<void> {
  vi.resetModules();
  chromeMock.reset();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.tabs.query.mockResolvedValue(tab ? [tab] : []);
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) =>
    message.type === "GET_STATE" ? { ...state, ...stateOverride } : message.type === "START_RECORDING" ? { meetingId: "new-meet" } : {},
  );
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ "notetaker.settings": settings }, resolve));
  if (pendingTabId !== undefined) await chromeMock.storage.session.set({ "notetaker.pendingMeetStart": { tabId: pendingTabId, createdAt: Date.now(), ...pendingExtra } });
  await import("../src/popup/popup");
  await vi.waitFor(() => expect(document.querySelector("#export-recordings")).not.toBeNull());
}

describe("browser recorder popup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("starts from a Meet tab and asks for no provider setup", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" });
    expect(document.body.textContent).toContain("Browser meeting recorder");
    expect(document.body.textContent).not.toContain("API key");
    (document.querySelector("#start-recording") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "START_RECORDING", captureSource: "meet", tabId: 7 })));
  });

  it("offers resume and discard for an interrupted recording", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, { recoverableMeeting: { meetingId: "m-rec", startedAt: "2026-10-01T10:00:00.000Z" } });
    expect(document.querySelector("#recoverable-banner")).not.toBeNull();
    (document.querySelector("#resume-recording") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "RESUME_RECORDING", meetingId: "m-rec" }));

    vi.spyOn(window, "confirm").mockReturnValue(false);
    (document.querySelector("#discard-recording") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DISCARD_RECORDING" }));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    (document.querySelector("#discard-recording") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "DISCARD_RECORDING", meetingId: "m-rec" }));
  });

  it("starts from a secure Teams tab", async () => {
    await loadPopup({ id: 8, url: "https://teams.microsoft.com/v2/" });
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(false);
    (document.querySelector("#start-recording") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "START_RECORDING", captureSource: "meet", tabId: 8 })));
  });

  it("disables Start outside a secure web tab", async () => {
    await loadPopup({ id: 1, url: "chrome://newtab" });
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("Open a secure browser meeting tab");
    expect(document.querySelector("#use-desktop")).toBeNull();
  });

  it("opens recording setup when consent is missing", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, { ...DEFAULT_SETTINGS, onboardingComplete: false });
    expect(document.querySelector("#start-recording")).toBeNull();
    (document.querySelector("#open-setup") as HTMLButtonElement).click();
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: expect.stringContaining("onboarding/onboarding.html") });
  });

  it("offers Stop for an active Meet capture and keeps desktop capture in the app", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, { activeMeeting: { id: "active" } });
    // A missing record cannot be presented as a live Meet capture.
    expect(document.querySelector("#stop-recording")).toBeNull();
    expect(document.querySelector("#start-recording")).toHaveProperty("disabled", true);
  });

  it("stops an active Meet recording", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, { activeMeeting: { id: "active" } });
    await new Promise<void>((resolve) => chromeMock.storage.local.set({
      "notetaker.meeting.active": { id: "active", title: "Call", captureSource: "meet", status: "recording", startedAt: "2026-10-04T00:00:00Z", transcript: [], actionItems: [] },
    }, resolve));
    chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)?.[0]({ type: "MEETING_STATE_CHANGED", meetingId: "active" });
    await vi.waitFor(() => expect(document.querySelector("#stop-recording")).not.toBeNull());
    (document.querySelector("#stop-recording") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "STOP_RECORDING", meetingId: "active" }));
  });

  it("drops Stop and explains when a capture fails mid-call", async () => {
    const live = { activeMeeting: { id: "active" } as { id: string } | null };
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, live);
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) => (message.type === "GET_STATE" ? { ...state, ...live } : {}));
    await new Promise<void>((resolve) => chromeMock.storage.local.set({
      "notetaker.meeting.active": { id: "active", title: "Call", captureSource: "meet", status: "recording", startedAt: "2026-10-04T00:00:00Z", transcript: [], actionItems: [] },
    }, resolve));
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)![0];
    listener({ type: "MEETING_STATE_CHANGED", meetingId: "active" });
    await vi.waitFor(() => expect(document.querySelector("#stop-recording")).not.toBeNull());

    live.activeMeeting = null;
    await new Promise<void>((resolve) => chromeMock.storage.local.set({
      "notetaker.meeting.active": { id: "active", title: "Call", captureSource: "meet", status: "error", errorMessage: "Call audio stopped.", startedAt: "2026-10-04T00:00:00Z", transcript: [], actionItems: [] },
    }, resolve));
    listener({ type: "RECORDING_ERROR", meetingId: "active", message: "Call audio stopped." });
    await vi.waitFor(() => expect(document.querySelector("#stop-recording")).toBeNull());
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Call audio stopped.");
  });

  it("opens archive export from Settings", async () => {
    await loadPopup({ id: 1, url: "chrome://newtab" });
    (document.querySelector("#export-recordings") as HTMLButtonElement).click();
    expect(chromeMock.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it.each(["https://meet.google.com/abc-defg-hij", "https://teams.microsoft.com/v2/", "https://us02web.zoom.us/wc/123/join", "https://discord.com/channels/@me/123", "https://app.slack.com/client/T1/C1"])("completes the widget pending start on %s", async (url) => {
    await loadPopup({ id: 7, url }, undefined, {}, 7);
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "START_RECORDING", captureSource: "meet", tabId: 7, meetingMode: "general" }));
  });

  it("honors the notes style chosen in the widget for the pending start", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, {}, 7, { meetingMode: "standup", titleHint: "Daily" });
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "START_RECORDING", captureSource: "meet", tabId: 7, meetingMode: "standup", titleHint: "Daily" }));
  });

  it("falls back to the default notes style when the pending one is not a known mode", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, { ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true, defaultMeetingMode: "sales" }, {}, 7, { meetingMode: "bogus" });
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "START_RECORDING", captureSource: "meet", tabId: 7, meetingMode: "sales" }));
  });

  it("does not start a pending capture from another tab", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, {}, 8);
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "START_RECORDING" }));
  });

  it("never lets a slow, older render paint over a newer one", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" });
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)![0];
    let releaseOld: () => void = () => {};
    let call = 0;
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) => {
      if (message.type !== "GET_STATE") return {};
      call += 1;
      if (call === 1) {
        // The older state: still offering to recover an interrupted recording.
        await new Promise<void>((resolve) => { releaseOld = resolve; });
        return { ...state, recoverableMeeting: { meetingId: "m-old", startedAt: "2026-10-01T10:00:00.000Z" } };
      }
      return state;
    });
    listener({ type: "MEETING_STATE_CHANGED", meetingId: "m-old" });
    await vi.waitFor(() => expect(call).toBe(1));
    listener({ type: "MEETING_STATE_CHANGED", meetingId: "m-old" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The newer render waits for the one in flight instead of racing it.
    expect(call).toBe(1);
    releaseOld();
    await vi.waitFor(() => expect(call).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelector("#recoverable-banner")).toBeNull();
  });
});

