import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { getMeeting, saveMeeting } from "../src/lib/storage";
import type { MeetingRecord } from "../src/types";

const day = (offset: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T00:00:00.000Z`;
};

const meeting: MeetingRecord = {
  id: "m1",
  title: "Planning",
  startedAt: "2026-09-24T14:30:00.000Z",
  endedAt: null,
  transcript: [],
  summary: null,
  actionItems: [
    { id: "later", text: "Later", status: "open", dueAt: day(7) },
    { id: "late", text: "Late", status: "open", dueAt: day(-3) },
    { id: "none", text: "Undated", status: "open", dueAt: null },
    { id: "fin", text: "Finished", status: "done", dueAt: day(-9) },
  ],
  status: "complete",
};

async function openActions(search = ""): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.reset();
  chromeMock.runtime.sendMessage.mockResolvedValue({});
  window.history.replaceState({}, "", `/actions/actions.html${search}`);
  await saveMeeting(meeting);
  await import("../src/actions/actions");
  await vi.waitFor(() => expect(document.querySelector(".action-list")).not.toBeNull());
}

const texts = (): string[] => [...document.querySelectorAll(".action-text")].map((el) => el.textContent ?? "");

describe("actions page", () => {
  beforeEach(() => document.body.replaceChildren());

  it("has no dead Record link to the popup", async () => {
    await openActions();
    expect(document.querySelector('a[href*="popup.html"]')).toBeNull();
  });

  it("sorts by due date (open first, undated last, done at the end) and marks overdue with text", async () => {
    await openActions();
    expect(texts()).toEqual(["Late", "Later", "Undated", "Finished"]);
    const lateRow = document.querySelectorAll(".action-row")[0]!;
    expect(lateRow.classList.contains("overdue")).toBe(true);
    expect(lateRow.querySelector(".due-badge")?.textContent).toBe("Overdue");
    expect(document.querySelectorAll(".action-row.overdue")).toHaveLength(1);
    expect(document.querySelector(".action-row.done .due-badge")).toBeNull();
  });

  it("updates the overdue highlight in place when a due date changes, without losing focus", async () => {
    await openActions();
    const due = document.querySelectorAll<HTMLInputElement>(".action-due")[1]!; // "Later"
    due.focus();
    due.value = day(-1).slice(0, 10);
    due.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(due.closest(".action-row")?.classList.contains("overdue")).toBe(true));
    expect(due.closest(".action-row")?.querySelector(".due-badge")?.textContent).toBe("Overdue");
    expect(document.activeElement).toBe(due);
  });

  it("keeps keyboard focus in the list after ticking an item", async () => {
    await openActions();
    const toggle = document.querySelectorAll<HTMLInputElement>(".action-toggle")[1]!;
    toggle.focus();
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(async () => expect((await getMeeting("m1"))?.actionItems.find((item) => item.id === "later")?.status).toBe("done"));
    await vi.waitFor(() => expect(document.activeElement?.classList.contains("action-toggle")).toBe(true));
  });

  it("falls back to the full list for an unknown status filter", async () => {
    await openActions("?status=bogus");
    expect(texts()).toHaveLength(4);
    expect(document.querySelector('a[aria-current="page"]')?.textContent).toBe("All");
  });
});
