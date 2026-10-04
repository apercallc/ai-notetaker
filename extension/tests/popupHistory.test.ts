import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

async function loadPopup(): Promise<void> {
  vi.resetModules();
  chromeMock.reset();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: "chrome://newtab" }]);
  chromeMock.runtime.sendMessage.mockResolvedValue({ activeMeeting: null, recoverableMeeting: null, helperStatus: "helper_not_found", helperInfo: null });
  const index: string[] = [];
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) {
    const id = `m${i}`;
    index.push(id);
    entries[`notetaker.meeting.${id}`] = {
      id, title: `Call ${i}`, startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      captureSource: i % 2 === 0 ? "meet" : "desktop", status: "saved", transcript: [], summary: null, actionItems: [],
    };
  }
  await new Promise<void>((resolve) => chromeMock.storage.local.set({
    "notetaker.settings": { ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true },
    "notetaker.meetings.index": index,
    ...entries,
  }, resolve));
  await import("../src/popup/popup");
  await vi.waitFor(() => expect(document.querySelectorAll(".recorder-list li")).toHaveLength(5));
}

describe("Meet recorder history", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows only five recent Meet recordings", async () => {
    await loadPopup();
    expect(document.querySelectorAll(".recorder-list li")).toHaveLength(5);
    expect(document.querySelector(".recorder-list")?.textContent).toContain("Audio saved");
    expect(document.querySelector(".recorder-list")?.textContent).not.toContain("Call 19");
  });

  it("keeps archive export visible without a provider key", async () => {
    await loadPopup();
    expect(document.querySelector("#export-recordings")).not.toBeNull();
    expect(document.body.textContent).toContain("import it in the desktop app");
    expect(document.body.textContent).not.toContain("API key");
  });
});
