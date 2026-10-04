import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

const archive = vi.hoisted(() => ({ saveDesktopAudioArchive: vi.fn().mockResolvedValue({ meetingCount: 2, audioBytes: 2048, chunkCount: 1 }) }));
vi.mock("../src/lib/desktopMigration", () => archive);

async function loadSettings(): Promise<void> {
  vi.resetModules();
  chromeMock.reset();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.runtime.sendMessage.mockResolvedValue({});
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ "notetaker.settings": DEFAULT_SETTINGS }, resolve));
  await import("../src/settings/recorderSettings");
  await vi.waitFor(() => expect(document.querySelector("#export-archive")).not.toBeNull());
}

describe("Meet recorder settings", () => {
  beforeEach(() => { vi.restoreAllMocks(); archive.saveDesktopAudioArchive.mockClear(); });

  it("shows recording controls and keeps prior settings accessible", async () => {
    await loadSettings();
    expect(document.querySelector("#show-widget")).not.toBeNull();
    expect(document.querySelector("#auto-record")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Paste API key");
    (document.querySelector("#open-previous-settings") as HTMLButtonElement).click();
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: expect.stringContaining("settings/legacy.html") });
  });

  it("saves recording preferences through the background controller", async () => {
    await loadSettings();
    const widget = document.querySelector("#show-widget") as HTMLInputElement;
    widget.checked = false;
    (document.querySelector("#save-settings") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "SAVE_SETTINGS", settings: expect.objectContaining({ showMeetWidget: false }),
    })));
  });

  it("exports the full archive without deleting source data", async () => {
    await loadSettings();
    (document.querySelector("#export-archive") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(archive.saveDesktopAudioArchive).toHaveBeenCalledOnce());
    expect(document.querySelector("#archive-status")?.textContent).toContain("Chrome data is unchanged");
  });
});
