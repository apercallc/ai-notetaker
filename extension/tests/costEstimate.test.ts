import { describe, expect, it } from "vitest";
import { estimateMeetingCost } from "../src/lib/costEstimate";

describe("estimateMeetingCost", () => {
  it("scales the documented 45-minute estimates by duration", () => {
    expect(estimateMeetingCost("default", 45)).toBeCloseTo(0.21);
    expect(estimateMeetingCost("budget", 90)).toBeCloseTo(0.06);
  });

  it("returns zero for invalid durations", () => {
    expect(estimateMeetingCost("default", 0)).toBe(0);
    expect(estimateMeetingCost("budget", Number.NaN)).toBe(0);
  });
});
