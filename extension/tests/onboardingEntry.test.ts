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

describe("onboarding entry point", () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"></main>';
    window.history.replaceState({}, "", "/onboarding/onboarding.html?mode=desktop");
    chromeMock.reset();
    chromeMock.runtime.sendMessage.mockResolvedValue(helperState);
    chromeMock.runtime.onMessage.addListener.mockReset();
  });

  it("keeps a stale desktop onboarding URL on Meet-first setup", async () => {
    await import("../src/onboarding/onboarding");

    await vi.waitFor(() => {
      expect(document.querySelector("#meeting-app")).not.toBeNull();
    });

    expect(document.querySelector<HTMLSelectElement>("#meeting-app")?.value).toBe("google-meet");
    expect(document.querySelector("#download-helper")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toContain("Choose where");
    expect(document.body.textContent).toContain("Google Meet uses the browser path");
  });

  it("rejects a copied desktop URL without an explicit session intent", async () => {
    vi.resetModules();
    document.body.innerHTML = '<main id="app"></main>';
    window.history.replaceState({}, "", "/onboarding/onboarding.html?mode=desktop&source=desktop");
    chromeMock.reset();
    chromeMock.runtime.sendMessage.mockResolvedValue(helperState);

    await import("../src/onboarding/onboarding");

    await vi.waitFor(() => expect(document.querySelector("#meeting-app")).not.toBeNull());
    expect(document.querySelector<HTMLSelectElement>("#meeting-app")?.value).toBe("google-meet");
    expect(document.querySelector("#download-helper")).toBeNull();
  });

  it("honors the short-lived intent created by explicit desktop setup", async () => {
    vi.resetModules();
    document.body.innerHTML = '<main id="app"></main>';
    window.history.replaceState({}, "", "/onboarding/onboarding.html?mode=desktop&source=desktop");
    chromeMock.reset();
    chromeMock.runtime.sendMessage.mockResolvedValue(helperState);
    await new Promise<void>((resolve) => chromeMock.storage.session.set({ "notetaker.desktopOnboardingIntentAt": Date.now() }, resolve));

    await import("../src/onboarding/onboarding");

    await vi.waitFor(() => expect(document.querySelector("#meeting-app")).not.toBeNull());
    expect(document.querySelector<HTMLSelectElement>("#meeting-app")?.value).toBe("other");
    expect(document.querySelector("#download-helper")).not.toBeNull();
    expect(chromeMock.storage.session._dump()).toEqual({});
  });
});
