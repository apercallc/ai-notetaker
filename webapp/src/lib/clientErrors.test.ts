import { describe, expect, it } from "vitest";
import { parseClientErrorReport, clientErrorLimiter } from "./clientErrors";

describe("parseClientErrorReport", () => {
  it("accepts a well-formed report and bounds every field", () => {
    const result = parseClientErrorReport({
      message: "x".repeat(1_000),
      surface: "meet_capture",
      stack: "y".repeat(10_000),
      meetingId: "z".repeat(500),
      extensionVersion: "0.1.0".padEnd(100, "0"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.message.length).toBe(500);
    expect(result.report.stack!.length).toBe(4_000);
    expect(result.report.meetingId!.length).toBe(128);
    expect(result.report.extensionVersion!.length).toBe(40);
  });

  it("rejects a missing message", () => {
    expect(parseClientErrorReport({ surface: "popup" })).toEqual({ ok: false, error: "message is required" });
    expect(parseClientErrorReport({ message: "   ", surface: "popup" })).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an unrecognized surface", () => {
    expect(parseClientErrorReport({ message: "boom", surface: "not-a-surface" })).toEqual({ ok: false, error: "surface is not recognized" });
    expect(parseClientErrorReport({ message: "boom" })).toEqual({ ok: false, error: "surface is not recognized" });
  });

  it("omits optional fields rather than storing undefined values", () => {
    const result = parseClientErrorReport({ message: "boom", surface: "widget" });
    expect(result.ok && !("stack" in result.report)).toBe(true);
    expect(result.ok && !("meetingId" in result.report)).toBe(true);
  });
});

describe("clientErrorLimiter", () => {
  it("allows a bounded burst per user and then reports 429 budget", () => {
    clientErrorLimiter.clear();
    for (let i = 0; i < 20; i += 1) {
      expect(clientErrorLimiter.hit("user-1").allowed).toBe(true);
    }
    const blocked = clientErrorLimiter.hit("user-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // A second user has their own budget.
    expect(clientErrorLimiter.hit("user-2").allowed).toBe(true);
  });
});
