import { beforeEach, describe, expect, it, vi } from "vitest";

const captureWarning = vi.hoisted(() => vi.fn());
vi.mock("./observability", () => ({ captureWarning }));

import { parseClientErrorReport, clientErrorLimiter, recordClientError } from "./clientErrors";

beforeEach(() => captureWarning.mockClear());

describe("parseClientErrorReport", () => {
  it("accepts a well-formed report and bounds every field", () => {
    const result = parseClientErrorReport({
      message: "provider response with private transcript and bearer token",
      surface: "meet_capture",
      errorClass: "TypeError",
      stack: "user transcript, signed url, and credentials",
      meetingId: "private-meeting-identifier",
      extensionVersion: "not-a-semver-identifier-containing-private-data",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toEqual({ message: "meet_capture operation failed", surface: "meet_capture", errorClass: "TypeError" });
    expect(JSON.stringify(result.report)).not.toContain("private");
  });

  it("does not require or relay a caller-provided error message", () => {
    expect(parseClientErrorReport({ surface: "popup" })).toEqual({ ok: true, report: { message: "popup operation failed", surface: "popup" } });
    expect(parseClientErrorReport({ message: "secret transcript", surface: "popup" })).toEqual({ ok: true, report: { message: "popup operation failed", surface: "popup" } });
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

  it("sends only stable labels to Sentry and omits stacks, meeting IDs, and workspace identity", () => {
    const result = recordClientError({ userId: "user-private", workspaceId: "workspace-private", email: "person@example.test" }, {
      message: "provider said: private transcript",
      stack: "private stack with token",
      meetingId: "meeting-private",
      surface: "managed_upload",
      errorClass: "AbortError",
      extensionVersion: "1.2.3",
    });
    expect(result).toEqual({ ok: true });
    expect(captureWarning).toHaveBeenCalledWith("extension error: managed_upload operation failed", {
      clientSurface: "managed_upload",
      errorClass: "AbortError",
      extensionVersion: "1.2.3",
    });
    expect(JSON.stringify(captureWarning.mock.calls)).not.toMatch(/private|person@example/);
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
