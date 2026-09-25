import { describe, expect, it } from "vitest";
import {
  displayTitle,
  exportAsMarkdown,
  exportAsPlainText,
  exportFileName,
  formatActionItemsForCopy,
  formatNotesForCopy,
  parseSummary,
  renderSummaryHtml,
  singleLine,
} from "../src/meeting/meetingView";
import type { MeetingRecord } from "../src/types";

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m1",
    title: "Planning",
    startedAt: "2026-09-24T14:30:00.000Z",
    endedAt: "2026-09-24T15:00:00.000Z",
    transcript: [],
    summary: "We agreed to ship.",
    actionItems: [
      { text: "Write plan", owner: "Ari", status: "open", dueAt: "2026-10-01T00:00:00.000Z" },
      { text: "Send notes", status: "done" },
    ],
    status: "complete",
    ...overrides,
  };
}

const STRUCTURED = `## Overview
The team reviewed the launch.

## Key points
- Scope is fixed
- QA starts Monday

## Decisions
- Ship on the 30th

## Action items
- Ari writes the plan`;

describe("parseSummary", () => {
  it("splits markdown-headed summaries into overview, key points, decisions and action items", () => {
    const sections = parseSummary(STRUCTURED)!;
    expect(sections.map((section) => [section.kind, section.title])).toEqual([
      ["overview", "Overview"],
      ["key_points", "Key points"],
      ["decisions", "Decisions"],
      ["action_items", "Action items"],
    ]);
    expect(sections[1]!.blocks).toEqual([{ type: "li", text: "Scope is fixed" }, { type: "li", text: "QA starts Monday" }]);
  });

  it("also understands bold, colon and all-caps headings, and text before the first heading as the overview", () => {
    const sections = parseSummary("Quick sync about pricing.\n\n**Key Points**\n* One\n\nDECISIONS\n1. Raise prices\n\nNext steps:\n- Email finance")!;
    expect(sections.map((section) => section.kind)).toEqual(["overview", "key_points", "decisions", "action_items"]);
  });

  it("returns null for plain prose so the caller can show it verbatim", () => {
    expect(parseSummary("We agreed to ship on Friday.\nNo blockers.")).toBeNull();
    expect(parseSummary("Note: this one has a colon but no known section")).toBeNull();
  });
});

describe("renderSummaryHtml", () => {
  it("renders sections with lists, and can drop the summary's action items when the interactive list is shown", () => {
    const html = renderSummaryHtml(STRUCTURED);
    expect(html).toContain("<h3>Key points</h3><ul><li>Scope is fixed</li><li>QA starts Monday</li></ul>");
    expect(html).toContain('data-kind="action_items"');
    expect(renderSummaryHtml(STRUCTURED, { hideActionItems: true })).not.toContain("action_items");
  });

  it("falls back to pre-wrapped plain text for unstructured summaries", () => {
    expect(renderSummaryHtml("Line one\nLine two")).toBe('<p class="summary-plain">Line one\nLine two</p>');
  });

  it("escapes markup in both structured and plain summaries", () => {
    const structured = renderSummaryHtml('## Key points\n- <img src=x onerror="alert(1)">\n## <script>alert(1)</script>');
    expect(structured).not.toContain("<img");
    expect(structured).not.toContain("<script");
    expect(structured).toContain("&lt;img");
    expect(renderSummaryHtml("<b>hi</b>")).toContain("&lt;b&gt;");
  });
});

describe("exports", () => {
  it("strips newlines from the title so it cannot inject markdown structure", () => {
    const evil = meeting({ title: "Standup\n## Injected heading\r\nmore" });
    const markdown = exportAsMarkdown(evil);
    expect(markdown.split("\n")[0]).toBe("# Standup ## Injected heading more");
    expect(markdown).not.toContain("\n## Injected heading");
    expect(exportAsPlainText(evil).split("\n")[0]).toBe("Standup ## Injected heading more");
    expect(formatNotesForCopy(evil).split("\n")[0]).toBe("# Standup ## Injected heading more");
    expect(singleLine("a b\u0000c")).toBe("a b c");
  });

  it("falls back for an empty title and builds a safe file name", () => {
    expect(displayTitle({ title: "\n\n" })).toBe("Untitled meeting");
    expect(exportFileName({ title: "Q4 / Plan: go!" }, "md")).toBe("Q4-Plan-go.md");
    expect(exportFileName({ title: "!!!" }, "txt")).toBe("meeting.txt");
  });

  it("formats action items and notes for the clipboard", () => {
    expect(formatActionItemsForCopy(meeting())).toBe("- [ ] Write plan (Ari) — due 2026-10-01\n- [x] Send notes");
    const notes = formatNotesForCopy(meeting());
    expect(notes).toContain("## Summary\nWe agreed to ship.");
    expect(notes).toContain("- [ ] Write plan (Ari) — due 2026-10-01");
    expect(notes).not.toContain("Transcript");
    expect(formatNotesForCopy(meeting({ summary: null, actionItems: [] }))).toContain("_No summary available._");
  });
});
