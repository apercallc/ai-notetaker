import { describe, expect, it } from "vitest";
import { actionItemLine, actionItemsToText, dueDateInputValue, isOverdue, isValidDateOnly, utcDateString } from "./actionItems";
import { errorCopyForPath } from "./errorCopy";
import { modeLabel } from "./meetingText";
import { isManagedPlan, planLabel, statusLabel } from "./plans";
import { formatOffset, groupTurns, transcriptOffsets, type TranscriptLine } from "./transcript";
import { parseSummary } from "./summaryFormat";

describe("action item display helpers", () => {
  it("formats dates and validates real UTC calendar days", () => {
    expect(utcDateString(new Date("2026-09-27T23:59:00.000Z"))).toBe("2026-09-27");
    expect(dueDateInputValue("2026-10-01T00:00:00.000Z")).toBe("2026-10-01");
    expect(dueDateInputValue(null)).toBe("");
    expect(isValidDateOnly("2024-02-29")).toBe(true);
    expect(isValidDateOnly("2026-02-31")).toBe(false);
    expect(isValidDateOnly("2026-2-01")).toBe(false);
    expect(isValidDateOnly("nope")).toBe(false);
  });

  it("only treats open items with an earlier due date as overdue", () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    expect(isOverdue({ status: "open", dueAt: "2026-09-26T00:00:00.000Z" }, now)).toBe(true);
    expect(isOverdue({ status: "open", dueAt: "2026-09-27T00:00:00.000Z" }, now)).toBe(false);
    expect(isOverdue({ status: "done", dueAt: "2026-09-01T00:00:00.000Z" }, now)).toBe(false);
    expect(isOverdue({ status: "open", dueAt: null }, now)).toBe(false);
  });

  it("exports a readable checklist without inventing owner or due-date text", () => {
    expect(actionItemLine({ text: "Send notes", owner: "Sam", status: "open", dueAt: "2026-10-01T00:00:00Z" }))
      .toBe("- [ ] Send notes (Sam) — due 2026-10-01");
    expect(actionItemsToText([
      { text: "Review", owner: null, status: "done", dueAt: null },
      { text: "Ship", owner: null, status: "open", dueAt: null },
    ])).toBe("- [x] Review\n- [ ] Ship");
    expect(actionItemsToText([])).toBe("");
  });
});

describe("summary and transcript display helpers", () => {
  it("parses headings, prose and separate ordered/unordered lists as plain data", () => {
    expect(parseSummary("# Decisions ##\nAgree on **scope**\n\n**Owners**:\n• Sam\n* Lee\n\nNext steps:\n1. `Draft`\n2) Review"))
      .toEqual([
        { type: "heading", text: "Decisions" },
        { type: "paragraph", text: "Agree on scope" },
        { type: "heading", text: "Owners" },
        { type: "list", ordered: false, items: ["Sam", "Lee"] },
        { type: "heading", text: "Next steps" },
        { type: "list", ordered: true, items: ["Draft", "Review"] },
      ]);
    expect(parseSummary("First line\r\ncontinued\r\n- one\nplain text\n- two\n\n"))
      .toEqual([
        { type: "paragraph", text: "First line\ncontinued" },
        { type: "list", ordered: false, items: ["one"] },
        { type: "paragraph", text: "plain text" },
        { type: "list", ordered: false, items: ["two"] },
      ]);
    expect(parseSummary("")).toEqual([]);
  });

  it("trusts only plausible timestamp spreads inside the meeting and groups adjacent speakers", () => {
    const lines: TranscriptLine[] = [
      { speaker: "Sam", text: "Hello", timestamp: "2026-09-27T10:00:02.900Z" },
      { speaker: "Sam", text: "Again", timestamp: "2026-09-27T10:00:03.100Z" },
      { speaker: "Lee", text: "Hi", timestamp: "2026-09-27T10:01:00.000Z" },
      { speaker: "Pat", text: "Late", timestamp: "2026-09-27T10:02:01.000Z" },
    ];
    expect(transcriptOffsets("2026-09-27T10:00:00.000Z", "2026-09-27T10:01:00.000Z", lines)).toEqual([2, 3, 60, null]);
    expect(groupTurns("2026-09-27T10:00:00.000Z", "2026-09-27T10:01:00.000Z", lines)).toEqual([
      { speaker: "Sam", offsetSeconds: 2, lines: ["Hello", "Again"] },
      { speaker: "Lee", offsetSeconds: 60, lines: ["Hi"] },
      { speaker: "Pat", offsetSeconds: null, lines: ["Late"] },
    ]);
    expect(transcriptOffsets("invalid", "also invalid", lines)).toEqual([null, null, null, null]);
    expect(transcriptOffsets("2026-09-27T10:00:00Z", "2026-09-27T10:02:00Z", [
      lines[0]!, { ...lines[1]!, timestamp: "bad" },
    ])).toEqual([null, null]);
    expect(transcriptOffsets("2026-09-27T10:00:00Z", "2026-09-27T10:02:00Z", [])).toEqual([]);
    expect(transcriptOffsets("2026-09-27T10:00:00Z", "2026-09-27T10:02:00Z", [
      lines[0]!, { ...lines[0]!, timestamp: "2026-09-27T10:00:02.950Z" },
    ])).toEqual([null, null]);
  });

  it("formats offsets across minute/hour boundaries and labels only non-default meeting modes", () => {
    expect(formatOffset(-4)).toBe("0:00");
    expect(formatOffset(65)).toBe("1:05");
    expect(formatOffset(3_661)).toBe("1:01:01");
    expect(modeLabel("")).toBeNull();
    expect(modeLabel("general")).toBeNull();
    expect(modeLabel("one_on_one")).toBe("1:1");
  });
});

describe("plan and route error copy", () => {
  it("keeps known plans and billing statuses human-readable while handling future values", () => {
    expect(isManagedPlan("hosted_pro")).toBe(true);
    expect(isManagedPlan("unexpected_plan")).toBe(false);
    expect(planLabel("hosted_trial")).toBe("Free trial");
    expect(planLabel("future_plan")).toBe("Future Plan");
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("trialing")).toBe("Trial");
    expect(statusLabel("past_due")).toBe("Payment past due");
    expect(statusLabel("canceled")).toBe("Canceled");
    expect(statusLabel("unpaid")).toBe("Unpaid");
    expect(statusLabel("incomplete")).toBe("Awaiting payment");
    expect(statusLabel("incomplete_expired")).toBe("Expired");
    expect(statusLabel("paused")).toBe("Paused");
    expect(statusLabel("inactive")).toBe("No subscription");
    expect(statusLabel("pending_review")).toBe("pending review");
  });

  it("shows route-specific recovery guidance without saying billing notes are safe", () => {
    expect(errorCopyForPath("/billing").title).toContain("Plans & usage");
    expect(errorCopyForPath("/team/members").title).toContain("team");
    expect(errorCopyForPath("/account/security").title).toContain("account");
    expect(errorCopyForPath("/login").backHref).toBe("/login");
    expect(errorCopyForPath("/actions").title).toContain("action items");
    expect(errorCopyForPath("/meetings").body).toContain("saved meetings");
    expect(errorCopyForPath(null).backHref).toBe("/meetings");
  });
});
