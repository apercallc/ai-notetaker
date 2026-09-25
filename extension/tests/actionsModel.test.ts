import { describe, expect, it } from "vitest";
import { dueState, localDateKey, parseFilter, sortActionRows, type ActionRow } from "../src/actions/actionsModel";
import type { MeetingRecord } from "../src/types";

const NOW = new Date(2026, 8, 24, 15, 0, 0); // local time, 24 Sep 2026

const row = (text: string, dueAt: string | null, status: "open" | "done", startedAt = "2026-09-01T10:00:00.000Z", index = 0): ActionRow => ({
  meeting: { id: text, startedAt } as MeetingRecord,
  item: { text, dueAt, status },
  index,
  status,
});

describe("dueState", () => {
  it("flags open items due before today as overdue, today as due today, later as upcoming", () => {
    expect(localDateKey(NOW)).toBe("2026-09-24");
    expect(dueState("open", "2026-09-23T00:00:00.000Z", NOW)).toBe("overdue");
    expect(dueState("open", "2026-09-24", NOW)).toBe("today");
    expect(dueState("open", "2026-09-25T00:00:00.000Z", NOW)).toBe("upcoming");
    expect(dueState("open", null, NOW)).toBe("none");
  });

  it("never marks a completed item overdue", () => {
    expect(dueState("done", "2020-01-01T00:00:00.000Z", NOW)).toBe("upcoming");
  });
});

describe("sortActionRows", () => {
  it("puts open items before done, soonest due first, undated last, newer meetings first on ties", () => {
    const sorted = sortActionRows([
      row("undated", null, "open"),
      row("later", "2026-10-05T00:00:00.000Z", "open"),
      row("done-early", "2026-09-01T00:00:00.000Z", "done"),
      row("soon-old", "2026-09-30T00:00:00.000Z", "open", "2026-08-01T10:00:00.000Z"),
      row("soon-new", "2026-09-30T00:00:00.000Z", "open", "2026-09-20T10:00:00.000Z"),
      row("overdue", "2026-09-10T00:00:00.000Z", "open"),
    ]);
    expect(sorted.map((entry) => entry.item.text)).toEqual(["overdue", "soon-new", "soon-old", "later", "undated", "done-early"]);
  });

  it("does not mutate its input", () => {
    const input = [row("b", "2026-10-02", "open"), row("a", "2026-10-01", "open")];
    sortActionRows(input);
    expect(input[0]!.item.text).toBe("b");
  });
});

describe("parseFilter", () => {
  it("accepts only the known filters", () => {
    expect(parseFilter("open")).toBe("open");
    expect(parseFilter("done")).toBe("done");
    expect(parseFilter("bogus")).toBe("all");
    expect(parseFilter(null)).toBe("all");
  });
});
