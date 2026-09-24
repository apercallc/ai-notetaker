import { describe, expect, it } from "vitest";
import { driveTitle, formatMeetingNotes } from "../src/lib/meetingNotes";
import type { MeetingRecord } from "../src/types";

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "meeting-1",
    title: "Product planning / Q4",
    startedAt: "2026-09-24T14:30:00.000Z",
    endedAt: "2026-09-24T15:00:00.000Z",
    transcript: [
      { speaker: "you", text: "Welcome.", timestamp: "2026-09-24T14:31:00.000Z", isFinal: true },
      { speaker: "them-2", text: "Let's ship it.", timestamp: "2026-09-24T14:32:00.000Z", isFinal: true },
    ],
    summary: "Ship the new workflow.",
    actionItems: [
      { text: "Create the rollout plan", owner: "Ari", status: "open", dueAt: "2026-10-01T00:00:00.000Z" },
      { text: "Publish the notes", status: "done" },
    ],
    status: "complete",
    ...overrides,
  };
}

describe("meeting notes formatter", () => {
  it("renders a stable readable format with all required sections", () => {
    const notes = formatMeetingNotes(meeting());

    expect(notes).toContain("# Product planning / Q4");
    expect(notes.indexOf("## Summary")).toBeLessThan(notes.indexOf("## Key decisions"));
    expect(notes).toContain("## Action items");
    expect(notes).toContain("- [ ] Create the rollout plan — Ari — due 2026-10-01");
    expect(notes).toContain("- [x] Publish the notes");
    expect(notes).toContain("## Discussion highlights");
    expect(notes).toContain("## Open questions");
    expect(notes).toContain("## Transcript");
    expect(notes).toContain("**You:** Welcome.");
    expect(notes).toContain("**Them 2:** Let's ship it.");
  });

  it("uses a collision-resistant Drive title without unsafe filename punctuation", () => {
    expect(driveTitle(meeting())).toBe("Product planning Q4 — 2026-09-24");
  });

  it("renders missing content as explicit empty sections", () => {
    const notes = formatMeetingNotes(meeting({ summary: null, transcript: [], actionItems: [] }));
    expect(notes).toContain("_No summary available._");
    expect(notes).toContain("_None recorded._");
  });
});
