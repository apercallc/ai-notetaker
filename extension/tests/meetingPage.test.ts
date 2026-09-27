import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { getMeeting, saveMeeting } from "../src/lib/storage";
import type { MeetingRecord } from "../src/types";

const base: MeetingRecord = {
  id: "m1",
  title: "Planning",
  startedAt: "2026-09-24T14:30:00.000Z",
  endedAt: "2026-09-24T15:00:00.000Z",
  transcript: [{ speaker: "you", text: "Hello", timestamp: "2026-09-24T14:31:00.000Z", isFinal: true }],
  summary: "## Overview\nShip it.\n\n## Key points\n- One\n\n## Decisions\n- Go\n\n## Action items\n- Duplicate of the list below",
  actionItems: [{ id: "a1", text: "Write plan", owner: "Ari", status: "open", dueAt: null }],
  status: "complete",
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function openMeeting(meeting: MeetingRecord = base): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.reset();
  chromeMock.runtime.sendMessage.mockResolvedValue({});
  window.history.replaceState({}, "", `/meeting/meeting.html?id=${meeting.id}`);
  await saveMeeting(meeting);
  await import("../src/meeting/meeting");
  await vi.waitFor(() => expect(document.getElementById("copy-notes")).not.toBeNull());
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("meeting page: summary", () => {
  it("renders structured sections and hides the summary's own action items while the interactive list is shown", async () => {
    await openMeeting();
    const kinds = [...document.querySelectorAll(".summary-section")].map((section) => (section as HTMLElement).dataset.kind);
    expect(kinds).toEqual(["overview", "key_points", "decisions"]);
    expect(document.querySelectorAll(".action-item")).toHaveLength(1);
  });

  it("shows the summary's action items when there is no interactive list, and pre-wraps plain summaries", async () => {
    await openMeeting({ ...base, actionItems: [] });
    expect(document.querySelector('[data-kind="action_items"]')).not.toBeNull();
    expect(($("copy-actions") as HTMLButtonElement).disabled).toBe(true);

    await openMeeting({ ...base, summary: "Just prose.\nSecond line." });
    expect(document.querySelector(".summary-plain")?.textContent).toBe("Just prose.\nSecond line.");
  });

  it("escapes hostile titles, summaries and action items", async () => {
    await openMeeting({
      ...base,
      title: '<img src=x onerror="alert(1)">',
      summary: "## Key points\n- <script>alert(1)</script>",
      actionItems: [{ id: "a1", text: '"><svg onload=alert(1)>', status: "open" }],
    });
    expect(document.querySelector("img, script, svg")).toBeNull();
    expect($("meeting-title").textContent).toBe('<img src=x onerror="alert(1)">');
  });
});

describe("meeting page: top actions", () => {
  it("copies the notes and the action items", async () => {
    await openMeeting();
    $("copy-notes").click();
    await vi.waitFor(() => expect($("copy-status").textContent).toBe("Notes copied."));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining("# Planning"));

    $("copy-actions").click();
    await vi.waitFor(() => expect($("copy-status").textContent).toBe("Action items copied."));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("- [ ] Write plan (Ari)");
  });

  it("reports a clipboard failure as an error", async () => {
    await openMeeting();
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("denied"));
    $("copy-notes").click();
    await vi.waitFor(() => expect($("copy-status").className).toContain("invalid"));
    expect($("copy-status").textContent).toMatch(/could not copy/i);
  });

  it("renames the title inline, stores it trimmed and single-spaced, and can be cancelled", async () => {
    await openMeeting();
    $("rename-title").click();
    const input = $<HTMLInputElement>("rename-input");
    expect(document.activeElement).toBe(input);
    input.value = "  Q4   roadmap  ";
    $("rename-save").click();
    await vi.waitFor(() => expect($("meeting-title").textContent).toBe("Q4 roadmap"));
    expect((await getMeeting("m1"))?.title).toBe("Q4 roadmap");
    expect(document.title).toContain("Q4 roadmap");
    expect(document.activeElement).toBe($("rename-title"));

    $("rename-title").click();
    $<HTMLInputElement>("rename-input").value = "Nope";
    $<HTMLInputElement>("rename-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect($("meeting-title").textContent).toBe("Q4 roadmap");
  });
});

describe("meeting page: delete with undo", () => {
  it("does not use confirm(), can be undone, and otherwise deletes after the undo window", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    await openMeeting();
    vi.useFakeTimers();
    const { UNDO_DELETE_MS } = await import("../src/meeting/meeting");

    $("delete-meeting").click();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect($("undo-bar").hidden).toBe(false);
    expect(document.activeElement).toBe($("undo-delete"));

    $("undo-delete").click();
    expect($("undo-bar").hidden).toBe(true);
    expect(document.activeElement).toBe($("delete-meeting"));
    await vi.advanceTimersByTimeAsync(UNDO_DELETE_MS + 100);
    expect(await getMeeting("m1")).not.toBeNull();

    $("delete-meeting").click();
    await vi.advanceTimersByTimeAsync(UNDO_DELETE_MS + 100);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await getMeeting("m1")).toBeNull());
    expect(document.body.textContent).toContain("Meeting deleted");
  });
});
