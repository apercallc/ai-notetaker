import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, historyHeading, pageOf, resultsSummary } from "../src/popup/historyModel";

describe("historyModel", () => {
  it("pages a long list and reports what is left", () => {
    const items = Array.from({ length: 100 }, (_, index) => index);
    expect(pageOf(items, HISTORY_PAGE_SIZE)).toEqual({ visible: items.slice(0, 20), remaining: 80 });
    expect(pageOf(items, 200)).toEqual({ visible: items, remaining: 0 });
    expect(pageOf([], 20)).toEqual({ visible: [], remaining: 0 });
  });
  it("names the list by mode", () => {
    expect(historyHeading("q", true)).toBe("Search results");
    expect(historyHeading("", true)).toBe("All meetings");
    expect(historyHeading("", false)).toBe("Recent meetings");
  });
  it("summarizes matches only while searching", () => {
    expect(resultsSummary(1, "a")).toBe("1 match");
    expect(resultsSummary(3, "a")).toBe("3 matches");
    expect(resultsSummary(3, "")).toBe("");
  });
});
