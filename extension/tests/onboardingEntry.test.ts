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

  it("does not approve keys changed while their previous test is pending", async () => {
    const pending: Array<(result: { valid: boolean; message: string }) => void> = [];
    await loadWizard("/onboarding/onboarding.html", () => {
      chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
        if (message.type === "TEST_PROVIDER_KEY") {
          return new Promise((resolve) => pending.push(resolve));
        }
        return helperState;
      });
    });
    await vi.waitFor(() => expect(document.querySelector("#test-onboarding-keys")).not.toBeNull());
    const transcriptKey = document.querySelector<HTMLInputElement>("#onboarding-deepgram-key")!;
    const summaryKey = document.querySelector<HTMLInputElement>("#onboarding-claude-key")!;
    transcriptKey.value = "original-key";
    summaryKey.value = "summary-key";
    document.querySelector<HTMLButtonElement>("#test-onboarding-keys")!.click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    transcriptKey.value = "replacement-key";
    transcriptKey.dispatchEvent(new Event("input"));
    pending.splice(0).forEach((resolve) => resolve({ valid: true, message: "Valid" }));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#test-onboarding-keys")!.disabled).toBe(false));
    expect(document.querySelector("#onboarding-key-result")?.textContent).not.toContain("Valid");
    document.querySelector<HTMLFormElement>("#onboarding-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "TEST_PROVIDER_KEY", key: "replacement-key" }));
    pending.splice(0).forEach((resolve) => resolve({ valid: false, message: "Invalid" }));
    await vi.waitFor(() => expect(document.querySelector("#step-error")?.textContent).toContain("did not pass"));
  });

  it("saves a typed key immediately when the tab is closed inside the autosave delay", async () => {
    await loadWizard("/onboarding/onboarding.html");
    await vi.waitFor(() => expect(document.querySelector("#onboarding-deepgram-key")).not.toBeNull());
    chromeMock.runtime.sendMessage.mockClear();
    const key = document.querySelector<HTMLInputElement>("#onboarding-deepgram-key")!;
    key.value = "typed-just-now";
    key.dispatchEvent(new Event("input"));

    window.dispatchEvent(new Event("pagehide"));

    const saves = chromeMock.runtime.sendMessage.mock.calls.map((call) => call[0] as { type: string; settings?: { apiKeys?: { deepgram?: string } } }).filter((message) => message.type === "SAVE_SETTINGS");
    expect(saves.at(-1)?.settings?.apiKeys?.deepgram).toBe("typed-just-now");
  });
});
