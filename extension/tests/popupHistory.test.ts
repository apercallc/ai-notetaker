import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

async function loadPopup(override: Record<string, Record<string, unknown>> = {}): Promise<void> {
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
      ...override[id],
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
    const expectedDate = new Date(Date.UTC(2026, 0, 1, 0, 18)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    expect(document.querySelector(".recorder-list li span")?.textContent).toContain(expectedDate);
  });

  it("labels finished notes plainly", async () => {
    await loadPopup({ m18: { status: "complete", title: "Design <review>" } });
    const item = [...document.querySelectorAll(".recorder-list li")].find((li) => li.textContent?.includes("Design <review>"))!;
    expect(item.textContent).toContain("Notes ready");
    expect(item.textContent).not.toContain("Legacy");
    const link = item.querySelector<HTMLButtonElement>("[data-open-meeting]")!;
    expect(link.textContent).toBe("Open notes");
    expect(link.getAttribute("aria-label")).toBe("Open notes for Design <review>");
  });

  it("keeps archive export visible without a provider key", async () => {
    await loadPopup();
    expect(document.querySelector("#export-recordings")).not.toBeNull();
    expect(document.body.textContent).toContain("import them in the desktop app");
    expect(document.body.textContent).not.toContain("API key");
  });

  it("explains a failed recording briefly and links to its meeting page", async () => {
    const long = `Chrome stopped sharing this tab's audio. ${"Details ".repeat(40)}`;
    await loadPopup({
      m18: { status: "error", errorMessage: "Call audio could not be saved. <b>Start</b> recording again.", title: "Design <review>" },
      m16: { status: "error", errorMessage: long },
      m14: { status: "error" },
    });
    const items = [...document.querySelectorAll(".recorder-list li")];
    const failed = items.find((item) => item.textContent?.includes("Design <review>"))!;
    expect(failed.textContent).toContain("Needs attention");
    expect(failed.querySelector(".history-reason")?.textContent).toBe("Call audio could not be saved. <b>Start</b> recording again.");
    // Untrusted text is escaped, never parsed as markup.
    expect(failed.querySelector("b")).toBeNull();
    const link = failed.querySelector<HTMLButtonElement>("[data-open-meeting]")!;
    expect(link.textContent).toBe("View details");
    expect(link.getAttribute("aria-label")).toBe("View details for Design <review>");
    link.click();
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: expect.stringContaining("meeting/meeting.html?id=m18") });

    const truncated = items.find((item) => item.textContent?.includes("Call 16"))!.querySelector(".history-reason")!.textContent!;
    expect(truncated.length).toBeLessThanOrEqual(140);
    expect(truncated.endsWith("…")).toBe(true);
    expect(items.find((item) => item.textContent?.includes("Call 14"))!.querySelector(".history-reason")?.textContent).toContain("audio saved before it stopped is kept");
    // Saved recordings carry no failure text.
    expect(items.find((item) => item.textContent?.includes("Call 12"))!.querySelector(".history-reason")).toBeNull();
  });
});
