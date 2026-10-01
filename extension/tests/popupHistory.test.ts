import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { DEFAULT_SETTINGS } from "../src/types";

const completedSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true };

async function seedMeetings(count: number): Promise<void> {
  const index: string[] = [];
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    const id = `m${String(i).padStart(3, "0")}`;
    index.push(id);
    entries[`notetaker.meeting.${id}`] = {
      id,
      title: i === 42 ? "Budget review" : `Meeting ${i}`,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      status: "complete",
      summary: "",
      transcript: [],
      actionItems: [],
    };
  }
  await new Promise<void>((resolve) => chromeMock.storage.local.set({ "notetaker.settings": completedSettings, "notetaker.meetings.index": index, ...entries }, resolve));
}

async function loadPopup(): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.reset();
  chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: "chrome://newtab" }]);
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type?: string }) =>
    message.type === "GET_STATE" ? { activeMeeting: null, recoverableMeeting: null, helperStatus: "helper_not_found", helperInfo: null } : {},
  );
  await seedMeetings(100);
  await import("../src/popup/popup");
}

const items = () => document.querySelectorAll(".history-item").length;

describe("popup history at 100 meetings", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows the newest five, then pages the whole archive on request", async () => {
    await loadPopup();
    await vi.waitFor(() => expect(items()).toBe(5));
    const more = document.getElementById("history-more") as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    more.click();
    await vi.waitFor(() => expect(items()).toBe(20));
    expect(document.getElementById("history-title")?.textContent).toBe("All meetings");
    (document.getElementById("history-more") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(items()).toBe(40));
  });

  it("searches live without a submit and reports the match count", async () => {
    await loadPopup();
    await vi.waitFor(() => expect(items()).toBe(5));
    const input = document.getElementById("meeting-search-input") as HTMLInputElement;
    input.value = "budget";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(items()).toBe(1));
    expect(document.getElementById("history-summary")?.textContent).toBe("1 match");
    expect(document.getElementById("clear-meeting-search")?.hasAttribute("hidden")).toBe(false);
  });
});
