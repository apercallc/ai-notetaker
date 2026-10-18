import { describe, expect, it } from "vitest";
import { googleErrorCodeForStatus, googleErrorText, meetingErrorText } from "./pageErrors";

describe("page error codes", () => {
  it("maps known meeting codes and never echoes arbitrary text", () => {
    expect(meetingErrorText(undefined)).toBeNull();
    expect(meetingErrorText("delete-forbidden")).toContain("Only the person who wrote this note");
    const crafted = "Your account is locked. Call +1 555 0100 to unlock it.";
    expect(meetingErrorText(crafted)).toBe("Something went wrong. Try again.");
    expect(meetingErrorText("constructor")).toBe("Something went wrong. Try again.");
  });

  it("maps Google codes with a generic fallback", () => {
    expect(googleErrorText(undefined)).toBeNull();
    expect(googleErrorText("denied")).toBe("Google authorization was cancelled or denied.");
    expect(googleErrorText("Visit evil.example to fix your account")).toBe("Google couldn't be connected. Try again.");
    expect(googleErrorText("toString")).toBe("Google couldn't be connected. Try again.");
  });

  it("derives a code from a Google integration error status", () => {
    expect(googleErrorCodeForStatus(503)).toBe("not-configured");
    expect(googleErrorCodeForStatus(409)).toBe("reconnect");
    expect(googleErrorCodeForStatus(400)).toBe("not-accepted");
    expect(googleErrorCodeForStatus(502)).toBe("unreachable");
    expect(googleErrorCodeForStatus(undefined)).toBe("unreachable");
    for (const code of ["not-configured", "reconnect", "not-accepted", "unreachable"]) {
      expect(googleErrorText(code)).not.toBe("Google couldn't be connected. Try again.");
    }
  });
});
