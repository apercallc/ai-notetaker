import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";

const helperState = {
  helperStatus: "helper_not_found" as const,
  helperInfo: null,
  activeMeeting: null,
  latest: null,
  recoverableMeeting: null,
  onboardingComplete: false,
  consentAcknowledged: false,
};

async function loadWizard(url: string, beforeLoad?: () => Promise<void> | void): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  window.history.replaceState({}, "", url);
  chromeMock.reset();
  chromeMock.runtime.sendMessage.mockResolvedValue(helperState);
  chromeMock.runtime.onMessage.addListener.mockReset();
  await beforeLoad?.();
  await import("../src/onboarding/onboarding");
}

describe("onboarding entry point", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a stale desktop onboarding URL on the Meet-first single setup screen", async () => {
    await loadWizard("/onboarding/onboarding.html?mode=desktop");

    await vi.waitFor(() => {
      expect(document.querySelector("#onboarding-form")).not.toBeNull();
    });

    // Meet path: one setup screen, no helper installer, no meeting-app detour.
    expect(document.querySelector("#download-helper")).toBeNull();
    expect(document.querySelector("#meeting-app")).toBeNull();
    expect(document.querySelector("#use-desktop")).not.toBeNull();
    expect(document.querySelector("#onboarding-mode-local")).not.toBeNull();
    expect(document.querySelector("#allow-microphone")).not.toBeNull();
    expect(document.querySelector("#consent-ack")).not.toBeNull();
    expect(document.querySelector("h1")?.textContent).toContain("Set up Notetaker");
  });

  it("rejects a copied desktop URL without an explicit session intent", async () => {
    await loadWizard("/onboarding/onboarding.html?mode=desktop&source=desktop");

    await vi.waitFor(() => expect(document.querySelector("#onboarding-form")).not.toBeNull());
    expect(document.querySelector("#download-helper")).toBeNull();
    expect(document.querySelector("#use-desktop")).not.toBeNull();
  });

  it("honors the short-lived intent created by explicit desktop setup", async () => {
    await loadWizard("/onboarding/onboarding.html?mode=desktop&source=desktop", () => {
      return new Promise<void>((resolve) => chromeMock.storage.session.set({ "notetaker.desktopOnboardingIntentAt": Date.now() }, resolve));
    });

    await vi.waitFor(() => expect(document.querySelector("#download-helper")).not.toBeNull());
    // Desktop detour starts at the helper step and hides the Meet mic section.
    expect(document.querySelector("h1")?.textContent).toContain("desktop calls");
    expect(document.querySelector("#allow-microphone")).toBeNull();
    expect(document.querySelector("#use-meet")).not.toBeNull();
    expect(chromeMock.storage.session._dump()).toEqual({});
  });

  it("lets the mic section be skipped only on the desktop detour", async () => {
    await loadWizard("/onboarding/onboarding.html");

    await vi.waitFor(() => expect(document.querySelector("#onboarding-form")).not.toBeNull());
    expect(document.querySelector<HTMLButtonElement>("#use-desktop")?.textContent).toContain("Zoom, Teams, or Slack");
  });
});