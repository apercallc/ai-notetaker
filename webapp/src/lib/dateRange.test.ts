import { describe, expect, it } from "vitest";
import { parseMeetingRange, rangeStart } from "./dateRange";

describe("meeting range", () => {
  it("parses known ids only", () => {
    expect(parseMeetingRange("30d")).toBe("30d");
    expect(parseMeetingRange("1y")).toBeUndefined();
    expect(parseMeetingRange(undefined)).toBeUndefined();
  });
  it("computes the window start", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    expect(rangeStart("7d", now)?.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(rangeStart(undefined, now)).toBeUndefined();
  });
});
