import { describe, expect, it } from "vitest";
import { safeEqual, isValidWorkerToken } from "./secureCompare";

describe("safeEqual", () => {
  it("matches identical strings and rejects everything else without length errors", () => {
    expect(safeEqual("worker-token", "worker-token")).toBe(true);
    expect(safeEqual("worker-token", "worker-tokens")).toBe(false);
    expect(safeEqual("worker-token", "")).toBe(false);
    expect(safeEqual("", "worker-token")).toBe(false);
    // A wrong token of a different length must not throw and must not match.
    expect(safeEqual("a", "worker-token-with-different-length")).toBe(false);
  });
});

describe("isValidWorkerToken", () => {
  it("accepts the configured token and fails closed otherwise", () => {
    const env = { MANAGED_WORKER_TOKEN: "worker-secret" };
    expect(isValidWorkerToken("worker-secret", env)).toBe(true);
    expect(isValidWorkerToken("worker-wrong", env)).toBe(false);
    expect(isValidWorkerToken(null, env)).toBe(false);
    expect(isValidWorkerToken(undefined, env)).toBe(false);
    expect(isValidWorkerToken("", env)).toBe(false);
    // Unset or empty configuration rejects everything.
    expect(isValidWorkerToken("worker-secret", {})).toBe(false);
    expect(isValidWorkerToken("worker-secret", { MANAGED_WORKER_TOKEN: "" })).toBe(false);
    expect(isValidWorkerToken("", {})).toBe(false);
  });
});