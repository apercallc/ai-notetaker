import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

const state = { activeMeeting: null, recoverableMeeting: null, helperStatus: "helper_not_found", helperInfo: null };

async function loadPopup(tab: { id: number; url: string } | null, settings = { ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true }, stateOverride: Record<string, unknown> = {}, pendingTabId?: number): Promise<void> {
  vi.resetModules();
  chromeMock.reset();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.tabs.query.mockResolvedValue(tab ? [tab] : []);
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) =>
    message.type === "GET_STATE" ? { ...state, ...stateOverride } : message.type === "START_RECORDING" ? { meetingId: "new-meet" } : {},
  );
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ "notetaker.settings": settings }, resolve));
  if (pendingTabId !== undefined) await chromeMock.storage.session.set({ "notetaker.pendingMeetStart": { tabId: pendingTabId, createdAt: Date.now() } });
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

  it("opens archive export from Settings", async () => {
    await loadPopup({ id: 1, url: "chrome://newtab" });
    (document.querySelector("#export-recordings") as HTMLButtonElement).click();
    expect(chromeMock.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it.each(["https://meet.google.com/abc-defg-hij", "https://teams.microsoft.com/v2/", "https://us02web.zoom.us/wc/123/join", "https://discord.com/channels/@me/123", "https://app.slack.com/client/T1/C1"])("completes the widget pending start on %s", async (url) => {
    await loadPopup({ id: 7, url }, undefined, {}, 7);
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "START_RECORDING", captureSource: "meet", tabId: 7 }));
  });

  it("does not start a pending capture from another tab", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, {}, 8);
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "START_RECORDING" }));
  });
});
