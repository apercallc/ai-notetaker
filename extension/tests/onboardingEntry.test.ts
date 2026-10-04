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
    await vi.waitFor(() => expect(document.querySelector("#setup-status")?.textContent).toContain("Microphone ready"));
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
  });

  it("ignores old desktop setup URLs", async () => {
    await loadWizard("/onboarding/onboarding.html?mode=desktop&source=desktop");
    expect(document.querySelector("#download-helper")).toBeNull();
    expect(document.querySelector("#allow-microphone")).not.toBeNull();
  });
});
