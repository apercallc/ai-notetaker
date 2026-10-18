import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

const microphone = vi.hoisted(() => ({
  requestMicrophone: vi.fn().mockResolvedValue("granted"),
  microphoneAlreadyAllowed: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/meet/micPermission", () => microphone);

async function loadWizard(url = "/onboarding/onboarding.html"): Promise<void> {
  vi.resetModules();
  chromeMock.reset();
  document.body.innerHTML = '<main id="app"></main>';
  window.history.replaceState({}, "", url);
  chromeMock.runtime.sendMessage.mockResolvedValue({});
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ "notetaker.settings": DEFAULT_SETTINGS }, resolve));
  await import("../src/onboarding/onboarding");
  await vi.waitFor(() => expect(document.querySelector("#allow-microphone")).not.toBeNull());
}

describe("browser recorder setup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    microphone.requestMicrophone.mockResolvedValue("granted");
    microphone.microphoneAlreadyAllowed.mockResolvedValue(false);
  });

  it("asks only for microphone and recording consent", async () => {
    await loadWizard();
    expect(document.body.textContent).toContain("Set up browser meeting recording");
    expect(document.querySelector("#onboarding-deepgram-key")).toBeNull();
    expect(document.querySelector("#download-helper")).toBeNull();
    expect((document.querySelector("#finish-setup") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves setup only after microphone access and consent", async () => {
    await loadWizard();
    (document.querySelector("#allow-microphone") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#setup-status")?.textContent).toContain("Microphone allowed"));
    expect((document.querySelector("#finish-setup") as HTMLButtonElement).disabled).toBe(true);
    const consent = document.querySelector("#recording-consent") as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change", { bubbles: true }));
    (document.querySelector("#finish-setup") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "SAVE_SETTINGS",
      settings: expect.objectContaining({ onboardingComplete: true, consentDisclosureAcknowledged: true }),
    })));
    expect(document.body.textContent).toContain("Ready to record");
    // Capture hints point at the toolbar icon, so the first step is pinning it.
    expect(document.querySelector("#ready-heading + p")?.textContent).toMatch(/^First, pin AI Notetaker to your toolbar: click the puzzle-piece icon/);
    // Keyboard and screen-reader users land on the new screen, not on <body>.
    expect(document.activeElement?.id).toBe("ready-heading");
  });

  it("keeps keyboard focus moving when the microphone button is used", async () => {
    await loadWizard();
    const allow = document.querySelector("#allow-microphone") as HTMLButtonElement;
    allow.focus();
    allow.click();
    await vi.waitFor(() => expect(document.querySelector("#setup-status")?.textContent).toContain("Microphone allowed"));
    // The button is done, so focus moves on to the consent step.
    expect(document.activeElement?.id).toBe("recording-consent");
    expect(document.querySelector("#allow-microphone")).toBeNull();
    expect(document.querySelector("#microphone-allowed")?.className).toBe("result ok");
    expect(document.querySelector("#microphone-allowed")?.textContent).toBe("Microphone allowed");
  });

  it("explains how to unblock a microphone Chrome blocked", async () => {
    microphone.requestMicrophone.mockResolvedValue("blocked");
    await loadWizard();
    (document.querySelector("#allow-microphone") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#setup-status")?.textContent).toBe(
      "Chrome blocked the microphone. Click the icon at the left of the address bar, set Microphone to Allow, then try again.",
    ));
    expect(document.querySelector("#setup-status")?.className).toBe("result error");
    expect(document.querySelector("#allow-microphone")).not.toBeNull();
  });

  it("shows a save failure without a raw error prefix", async () => {
    await loadWizard();
    microphone.requestMicrophone.mockResolvedValue("granted");
    (document.querySelector("#allow-microphone") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#setup-status")?.textContent).toContain("Microphone allowed"));
    const consent = document.querySelector("#recording-consent") as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change", { bubbles: true }));
    chromeMock.runtime.sendMessage.mockResolvedValue({ error: "Storage is full" });
    (document.querySelector("#finish-setup") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#setup-status")?.textContent).toContain("Storage is full"));
    expect(document.querySelector("#setup-status")?.textContent).not.toContain("Error:");
  });

  it("ignores old desktop setup URLs", async () => {
    await loadWizard("/onboarding/onboarding.html?mode=desktop&source=desktop");
    expect(document.querySelector("#download-helper")).toBeNull();
    expect(document.querySelector("#allow-microphone")).not.toBeNull();
  });
});
