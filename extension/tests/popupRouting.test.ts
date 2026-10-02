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

async function loadPopup(
  activeTab: { id: number; url: string } | undefined,
  sessionSeed?: Record<string, unknown>,
  stateOverride?: Record<string, unknown>,
  sendMessageImpl?: (message: { type?: string }) => Promise<unknown>,
  meetingSeed?: Record<string, unknown>,
): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.reset();
  chromeMock.tabs.query.mockResolvedValue(activeTab ? [activeTab] : []);
  chromeMock.runtime.sendMessage.mockImplementation(sendMessageImpl ?? (async (message: { type?: string }) => {
    if (message.type === "GET_STATE") return { ...state, ...stateOverride };
    if (message.type === "START_RECORDING") return { meetingId: "auto-started" };
    if (message.type === "GET_AUDIO_PREFLIGHT") return { status: {
      microphone: "Built-in microphone",
      speaker: "Built-in output",
      nativeLoopback: true,
      virtualDeviceFallback: false,
      driverInstalled: true,
      ready: true,
      guidance: "Ready.",
    } };
    return {};
  }));
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ [SETTINGS_KEY]: completedSettings }, resolve));
  if (meetingSeed) await new Promise<void>((resolve) => chromeMock.storage.local.set(meetingSeed, resolve));
  // Seeded after the reset but before the popup's first render, so the very
  // popup open that grants Chrome's tab invocation finds the intent waiting.
  if (sessionSeed) await new Promise<void>((resolve) => chromeMock.storage.session.set(sessionSeed, resolve));
  await import("../src/popup/popup");
}

describe("popup capture routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens Meet from the desktop view even when the helper is connected", async () => {
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    await loadPopup({ id: 1, url: "chrome://newtab" }, undefined, { helperStatus: "connected" });
    await vi.waitFor(() => expect(document.querySelector("#use-meet")).not.toBeNull());
    (document.querySelector("#use-meet") as HTMLButtonElement).click();
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: "https://meet.google.com/" });
  });

  it("shows helperless Meet live captions", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, {
      activeMeeting: { id: "m-live" },
    });
    // Seed the local meeting before the background GET_STATE continuation.
    await new Promise<void>((resolve) => chromeMock.storage.local.set({
      "notetaker.meeting.m-live": { id: "m-live", captureSource: "meet", liveTranscriptStatus: "available", transcript: [] },
    }, resolve));
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)?.[0];
    await vi.waitFor(() => expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalled());
    (listener ?? chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)![0])({ type: "MEETING_STATE_CHANGED", meetingId: "m-live" });
    await vi.waitFor(() => expect(document.querySelector("#transcript-view")).not.toBeNull());
    chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)![0]({ type: "TRANSCRIPT_UPDATE", meetingId: "m-live", speaker: "you", text: "Browser captions", isFinal: true });
    expect(document.querySelector("#transcript-view")?.textContent).toContain("Browser captions");
  });

  it("does not duplicate a final caption that arrived while the live view mounted", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" }, undefined, {
      activeMeeting: { id: "m-live" },
    });
    const segment = { speaker: "you", text: "Already saved", isFinal: true, utteranceId: 18, timestamp: new Date().toISOString() };
    await new Promise<void>((resolve) => chromeMock.storage.local.set({
      "notetaker.meeting.m-live": { id: "m-live", captureSource: "meet", liveTranscriptStatus: "available", transcript: [segment] },
    }, resolve));
    await vi.waitFor(() => expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalled());
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)![0];
    listener({ type: "MEETING_STATE_CHANGED", meetingId: "m-live" });
    listener({ type: "TRANSCRIPT_UPDATE", meetingId: "m-live", ...segment, text: "Still being transcribed", isFinal: false });
    listener({ type: "TRANSCRIPT_UPDATE", meetingId: "m-live", ...segment });

    await vi.waitFor(() => expect(document.querySelectorAll("#transcript-view .transcript-line")).toHaveLength(1));
    expect(document.querySelector("#transcript-view")?.textContent).toContain("Already saved");
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
    expect(document.querySelector("#mode-chip")?.textContent).toContain("Using Deepgram + Claude");
    expect(document.querySelector("#mode-chip")?.textContent).toContain("Hosted AI allowance is not used");
    expect(document.querySelector("#meet-auto-record-guidance")?.textContent).toContain("Auto-record on join is on");
  });

  it("shows that auto-record on join is enabled on the Meet popup", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" });

    await vi.waitFor(() => expect(document.querySelector("#start-recording")).not.toBeNull());
    expect(document.querySelector("#meet-auto-record-guidance")?.textContent).toContain("Auto-record on join is on");
    expect(document.querySelector("#meet-auto-record-guidance")?.textContent).toContain("one toolbar click starts it");
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

  it("offers Settings or explicit local recording after a provider check fails", async () => {
    await loadPopup({ id: 7, url: "https://meet.google.com/abc-defg-hij" });
    await vi.waitFor(() => expect(document.querySelector("#start-recording")).not.toBeNull());
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)?.[0] as (message: unknown) => void;
    listener({
      type: "RECORDING_ERROR",
      meetingId: null,
      phase: "start",
      recovery: "provider_preflight",
      message: "Groq did not respond. Recording has not started.",
    });
    expect((document.querySelector("#provider-preflight-actions") as HTMLDivElement).hidden).toBe(false);

    (document.querySelector("#continue-provider-warning") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "START_RECORDING",
      allowProviderWarning: true,
    })));
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

  it("updates desktop readiness in place when the helper reconnects", async () => {
    await loadPopup({ id: 1, url: "chrome://newtab" });
    await vi.waitFor(() => expect(document.querySelector("#use-desktop")).not.toBeNull());
    (document.querySelector("#use-desktop") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#desktop-helper-actions")).not.toBeNull());

    const startButton = document.querySelector("#start-recording");
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)?.[0] as (message: unknown) => void;
    listener({ type: "HELPER_STATUS", status: "connected" });
    await vi.waitFor(() => expect(document.querySelector("#audio-status")?.textContent).toContain("Audio ready"));
    expect(document.querySelector("#start-recording")).toBe(startButton);
    expect((startButton as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector("#open-helper-setup") as HTMLButtonElement).hidden).toBe(true);

    listener({ type: "HELPER_STATUS", status: "disconnected" });
    expect(document.querySelector("#desktop-helper-status")?.textContent).toContain("Can't reach");
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector("#open-helper-setup") as HTMLButtonElement).hidden).toBe(false);
  });

  it("keeps desktop recording disabled when audio preflight fails", async () => {
    const sendMessageImpl = async (message: { type?: string }): Promise<unknown> => {
      if (message.type === "GET_STATE") return { ...state, helperStatus: "connected" };
      if (message.type === "GET_AUDIO_PREFLIGHT") throw new Error("helper timeout");
      return {};
    };
    await loadPopup({ id: 1, url: "chrome://newtab" }, undefined, { helperStatus: "connected" }, sendMessageImpl);
    await vi.waitFor(() => expect(document.querySelector("#audio-status")?.textContent).toContain("Audio check failed"));
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector("#check-audio") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not re-enable the audio probe when the helper disconnects mid-test", async () => {
    let finishProbe!: (value: unknown) => void;
    const sendMessageImpl = async (message: { type?: string }): Promise<unknown> => {
      if (message.type === "GET_STATE") return { ...state, helperStatus: "connected" };
      if (message.type === "GET_AUDIO_PREFLIGHT") return { status: {
        microphone: "Built-in microphone", speaker: "Built-in output", nativeLoopback: true,
        virtualDeviceFallback: false, driverInstalled: true, ready: true, guidance: "Ready.",
      } };
      if (message.type === "RUN_AUDIO_PROBE") return new Promise((resolve) => { finishProbe = resolve; });
      return {};
    };
    await loadPopup({ id: 1, url: "chrome://newtab" }, undefined, { helperStatus: "connected" }, sendMessageImpl);
    await vi.waitFor(() => expect(document.querySelector("#test-audio")).not.toBeNull());
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)?.[0] as (message: unknown) => void;
    (document.querySelector("#test-audio") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
    listener({ type: "HELPER_STATUS", status: "disconnected" });
    finishProbe({ result: { passed: true, message: "Audio test passed." } });
    await vi.waitFor(() => expect(document.querySelector("#audio-status")?.textContent).toContain("Can't reach"));
    expect((document.querySelector("#test-audio") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns and offers setup if the helper disconnects during a desktop recording", async () => {
    await loadPopup(
      { id: 1, url: "chrome://newtab" },
      undefined,
      { helperStatus: "connected", activeMeeting: { id: "m-desktop" } },
      undefined,
      { "notetaker.meeting.m-desktop": {
        id: "m-desktop",
        captureSource: "desktop",
        transcript: [],
        liveTranscriptStatus: "unavailable",
      } },
    );
    await vi.waitFor(() => expect(document.querySelector("#recording-status")).not.toBeNull());
    await vi.waitFor(() => expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalled());

    const listener = chromeMock.runtime.onMessage.addListener.mock.calls.at(-1)?.[0] as (message: unknown) => void;
    listener({ type: "HELPER_STATUS", status: "disconnected" });

    await vi.waitFor(() => expect(document.querySelector("#recording-status-message")?.textContent).toContain("capture may have stopped"));
    expect((document.querySelector("#recording-helper-setup") as HTMLButtonElement).hidden).toBe(false);
  });
});
