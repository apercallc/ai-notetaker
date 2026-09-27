import { describe, expect, it } from "vitest";
import { isMeetUrl, meetTitle, meetTitleForTab, meetingCodeFromPath } from "../src/meet/meetContext";

describe("meet context helpers", () => {
  it("recognises only https meet.google.com URLs", () => {
    expect(isMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(isMeetUrl("http://meet.google.com/abc-defg-hij")).toBe(false);
    expect(isMeetUrl("https://meet.google.com.evil.example/abc-defg-hij")).toBe(false);
    expect(isMeetUrl("https://notmeet.google.com.example/")).toBe(false);
    expect(isMeetUrl("not a url")).toBe(false);
    expect(isMeetUrl(undefined)).toBe(false);
  });

  it("extracts the meeting code from call routes only", () => {
    expect(meetingCodeFromPath("/abc-defg-hij")).toBe("abc-defg-hij");
    expect(meetingCodeFromPath("/ABC-DEFG-HIJ/")).toBe("abc-defg-hij");
    expect(meetingCodeFromPath("/")).toBeNull();
    expect(meetingCodeFromPath("/landing")).toBeNull();
    expect(meetingCodeFromPath("/abc-defg-hij/extra")).toBeNull();
  });

  it("prefers a real meeting name from the tab title", () => {
    expect(meetTitle("Weekly sync - Google Meet", "abc-defg-hij")).toBe("Weekly sync");
    expect(meetTitle("Meet – Design review", "abc-defg-hij")).toBe("Design review");
  });

  it("falls back to the meeting code when the tab title is only the code or generic", () => {
    expect(meetTitle("Meet – abc-defg-hij", "abc-defg-hij")).toBe("Google Meet abc-defg-hij");
    expect(meetTitle("Google Meet", "abc-defg-hij")).toBe("Google Meet abc-defg-hij");
    expect(meetTitle(undefined, "abc-defg-hij")).toBe("Google Meet abc-defg-hij");
    expect(meetTitle("Google Meet", null)).toBeUndefined();
  });

  it("names a tab only when it is a Meet call", () => {
    expect(meetTitleForTab({ url: "https://meet.google.com/abc-defg-hij", title: "Retro - Google Meet" })).toBe("Retro");
    expect(meetTitleForTab({ url: "https://example.com/", title: "Retro" })).toBeUndefined();
    expect(meetTitleForTab(undefined)).toBeUndefined();
  });
});
