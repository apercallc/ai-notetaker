import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

const SETTINGS_KEY = "notetaker.settings";

const completedSettings = {
  ...DEFAULT_SETTINGS,
  onboardingComplete: true,
  consentDisclosureAcknowledged: true,
};

const state = {
  activeMeeting: null,
  recoverableMeeting: null,
  helperStatus: "helper_not_found" as const,
  helperInfo: null,
};

async function loadPopup(activeTab: { id: number; url: string } | undefined, sessionSeed?: Record<string, unknown>): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.reset();
  chromeMock.tabs.query.mockResolvedValue(activeTab ? [activeTab] : []);
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) => {
    if (message.type === "GET_STATE") return state;
    if (message.type === "START_RECORDING") return { meetingId: "auto-started" };
    return {};
  });
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ [SETTINGS_KEY]: completedSettings }, resolve));
  // Seeded after the reset but before the popup's first render, so the very
  // popup open that grants Chrome's tab invocation finds the intent waiting.
  if (sessionSeed) await new Promise<void>((resolve) => chromeMock.storage.session.set(sessionSeed, resolve));
  await import("../src/popup/popup");
}

describe("popup capture routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("detects the active tab: a non-Meet tab shows the way to Meet, not a dead Start", async () => {
    await loadPopup({ id: 1, url: "chrome://newtab" });

    await vi.waitFor(() => {
      expect(document.querySelector("#open-meet")).not.toBeNull();
    });

    expect(document.querySelector("#start-recording")).toBeNull();
    expect(document.querySelector("#desktop-helper-actions")).toBeNull();
    expect(document.querySelector("#use-desktop")?.textContent).toContain("Zoom or Teams");
    expect(document.body.textContent).not.toContain("Install desktop helper");
    expect(document.querySelector("#mode-chip")?.textContent).toContain("Your own API keys");
  });

  it("offers one Start button on a Meet tab and starts browser capture with the tab id", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" });

    await vi.waitFor(() => {
      expect(document.querySelector("#start-recording")).not.toBeNull();
    });

    const start = document.querySelector("#start-recording") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect(start.textContent).toContain("Start notes");
    expect(document.querySelector("#open-meet")).toBeNull();

    start.click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "START_RECORDING" })));
    const sent = chromeMock.runtime.sendMessage.mock.calls.map((call) => call[0]).find((m: { type?: string }) => m.type === "START_RECORDING");
    expect(sent).toEqual(expect.objectContaining({ captureSource: "meet", tabId: 7 }));
  });

  it("finishes a Chrome-gated widget start on the toolbar click that opens the popup", async () => {
    await loadPopup(
      { id: 7, url: "https://meet.google.com/abc-defg-hij" },
      { "notetaker.pendingMeetStart": { tabId: 7, meetingMode: "sales", titleHint: "Roadmap" } },
    );

    // The popup opening IS the invocation Chrome was waiting for, so the
    // remembered start fires by itself — no second Start press.
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "START_RECORDING" })));
    const sent = chromeMock.runtime.sendMessage.mock.calls.map((call) => call[0]).find((m: { type?: string }) => m.type === "START_RECORDING");
    expect(sent).toEqual(expect.objectContaining({ captureSource: "meet", tabId: 7, meetingMode: "sales", titleHint: "Roadmap" }));
    // The handoff is consumed exactly once.
    expect(chromeMock.storage.session._dump()["notetaker.pendingMeetStart"]).toBeUndefined();
  });

  it("ignores a remembered start for a different tab", async () => {
    await loadPopup(
      { id: 7, url: "https://meet.google.com/abc-defg-hij" },
      { "notetaker.pendingMeetStart": { tabId: 99, meetingMode: "sales" } },
    );

    // Give the popup's async render a moment; no auto-start may fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sent = chromeMock.runtime.sendMessage.mock.calls.map((call) => call[0]).find((m: { type?: string }) => m.type === "START_RECORDING");
    expect(sent).toBeUndefined();
    // But it is consumed, so it can never surprise a later popup open either.
    expect(chromeMock.storage.session._dump()["notetaker.pendingMeetStart"]).toBeUndefined();
  });

  it("reveals desktop setup only after the user says they are recording a desktop app", async () => {
    await loadPopup({ id: 1, url: "chrome://newtab" });
    await vi.waitFor(() => expect(document.querySelector("#use-desktop")).not.toBeNull());

    (document.querySelector("#use-desktop") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#desktop-helper-actions")).not.toBeNull());

    // Without a connected helper the desktop start stays off.
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("#open-helper-setup")?.textContent).toContain("Set up desktop capture");

    (document.querySelector("#open-helper-setup") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalled());
    expect(chromeMock.storage.session._dump()["notetaker.desktopOnboardingIntentAt"]).toEqual(expect.any(Number));
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://fake-extension-id/onboarding/onboarding.html?mode=desktop&source=desktop",
    });
  });
});
