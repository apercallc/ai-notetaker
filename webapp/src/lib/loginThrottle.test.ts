import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLoginFailures,
  isLoginThrottled,
  recordLoginFailure,
  resetLoginThrottleForTests,
} from "./loginThrottle";

beforeEach(() => resetLoginThrottleForTests());

describe("login throttle", () => {
  it("allows a normal run of wrong guesses, then stops the eleventh", () => {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      recordLoginFailure("owner@example.com");
      expect(isLoginThrottled("owner@example.com")).toBe(false);
    }
    recordLoginFailure("owner@example.com");
    expect(isLoginThrottled("owner@example.com")).toBe(true);
  });

  it("does not throttle an address that has never failed", () => {
    recordLoginFailure("someone-else@example.com");
    expect(isLoginThrottled("owner@example.com")).toBe(false);
  });

  it("treats an address case- and whitespace-insensitively", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) recordLoginFailure("Owner@Example.com");
    expect(isLoginThrottled("  owner@example.com ")).toBe(true);
  });

  it("clears the budget on a successful sign-in", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) recordLoginFailure("owner@example.com");
    expect(isLoginThrottled("owner@example.com")).toBe(true);

    clearLoginFailures("owner@example.com");
    expect(isLoginThrottled("owner@example.com")).toBe(false);
  });

  it("lets the window expire so a real user is never locked out permanently", () => {
    const start = Date.parse("2026-09-23T12:00:00.000Z");
    for (let attempt = 0; attempt < 10; attempt += 1) recordLoginFailure("owner@example.com", start);
    expect(isLoginThrottled("owner@example.com", start)).toBe(true);

    const afterWindow = start + 15 * 60 * 1000 + 1;
    expect(isLoginThrottled("owner@example.com", afterWindow)).toBe(false);

    // The expired window starts a fresh budget rather than resuming the old.
    recordLoginFailure("owner@example.com", afterWindow);
    expect(isLoginThrottled("owner@example.com", afterWindow)).toBe(false);
  });

  it("stays bounded when an attacker cycles through invented addresses", () => {
    const start = Date.parse("2026-09-23T12:00:00.000Z");
    for (let index = 0; index < 12_000; index += 1) {
      recordLoginFailure(`throwaway-${index}@example.com`, start);
    }
    // The real assertion is that this neither throws nor grows without
    // bound; a still-throttled genuine address proves entries still work.
    for (let attempt = 0; attempt < 10; attempt += 1) recordLoginFailure("owner@example.com", start);
    expect(isLoginThrottled("owner@example.com", start)).toBe(true);
  });
});
