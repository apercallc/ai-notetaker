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

describe("popup capture routing", () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<main id="app"></main>';
    chromeMock.reset();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: "chrome://newtab" }]);
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) => {
      if (message.type === "GET_STATE") return state;
      return {};
    });
    await new Promise<void>((resolve) => chromeMock.storage.local.set({ [SETTINGS_KEY]: completedSettings }, resolve));
  });

  it("keeps a non-Meet popup on browser capture without showing helper setup", async () => {
    await import("../src/popup/popup");

    await vi.waitFor(() => {
      expect(document.querySelector("#capture-source")).not.toBeNull();
    });

    expect((document.querySelector("#capture-source") as HTMLSelectElement).value).toBe("meet");
    expect((document.querySelector("#desktop-helper-actions") as HTMLDivElement).hidden).toBe(true);
    expect((document.querySelector("#start-recording") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Install desktop helper");
  });

  it("reveals explicit desktop setup only after selecting desktop capture", async () => {
    await import("../src/popup/popup");
    await vi.waitFor(() => expect(document.querySelector("#capture-source")).not.toBeNull());

    const captureSource = document.querySelector("#capture-source") as HTMLSelectElement;
    captureSource.value = "desktop";
    captureSource.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect((document.querySelector("#desktop-helper-actions") as HTMLDivElement).hidden).toBe(false);
    });
    expect(document.querySelector("#open-helper-setup")?.textContent).toContain("Set up desktop capture");

    (document.querySelector("#open-helper-setup") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalled());
    expect(chromeMock.storage.session._dump()["notetaker.desktopOnboardingIntentAt"]).toEqual(expect.any(Number));
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://fake-extension-id/onboarding/onboarding.html?mode=desktop&source=desktop",
    });
  });
});
