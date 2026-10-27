import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureServerError = vi.hoisted(() => vi.fn());
vi.mock("./observability", () => ({ captureServerError }));

import { logger } from "./logger";

function lastJson(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(String(call?.[0])) as Record<string, unknown>;
}

describe("logger", () => {
  let error: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("LOG_FORMAT", "json");
    vi.stubEnv("LOG_LEVEL", "");
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    captureServerError.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes one JSON line per event on the matching console method", () => {
    logger.info("job started", { jobId: "j1" });
    logger.warn("slow");
    logger.error("boom");

    expect(lastJson(info)).toMatchObject({ level: "info", message: "job started", jobId: "j1" });
    expect(lastJson(warn)).toMatchObject({ level: "warn", message: "slow" });
    expect(lastJson(error)).toMatchObject({ level: "error", message: "boom" });
    expect(typeof lastJson(info).time).toBe("string");
  });

  it("drops events below LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores an unrecognised LOG_LEVEL and falls back to info", () => {
    vi.stubEnv("LOG_LEVEL", "verbose");
    logger.debug("d");
    logger.info("i");

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
  });

  it("redacts credential-like keys at any depth", () => {
    logger.info("call", { authorization: "Bearer abc", nested: { apiKey: "k", ok: 1 }, list: [{ sessionToken: "t" }] });

    const out = lastJson(info);
    expect(out.authorization).toBe("[redacted]");
    expect(out.nested).toEqual({ apiKey: "[redacted]", ok: 1 });
    expect(out.list).toEqual([{ sessionToken: "[redacted]" }]);
  });

  it("serializes errors with name, message and a bounded stack", () => {
    logger.error("failed", { error: new TypeError("bad input") });

    const serialized = lastJson(error).error as { name: string; message: string; stack: string };
    expect(serialized).toMatchObject({ name: "TypeError", message: "bad input" });
    expect(serialized.stack.split("\n").length).toBeLessThanOrEqual(11);
  });

  it("normalises `err` to `error`", () => {
    logger.error("failed", { err: new Error("x") });

    const out = lastJson(error);
    expect(out.err).toBeUndefined();
    expect((out.error as { message: string }).message).toBe("x");
  });

  it("bounds long strings, large arrays, deep objects and cycles", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    logger.info("shape", {
      long: "x".repeat(2_000),
      many: Array.from({ length: 50 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: 1 } } } } },
      cyclic,
    });

    const out = lastJson(info) as { long: string; many: unknown[]; deep: unknown; cyclic: { self: string } };
    expect(out.long.length).toBeLessThan(600);
    expect(out.many).toHaveLength(21);
    expect(out.many.at(-1)).toBe("[+30 more]");
    expect(JSON.stringify(out.deep)).toContain("[truncated]");
    expect(out.cyclic.self).toBe("[circular]");
  });

  it("does not let context spoof the reserved fields", () => {
    logger.info("real", { level: "error", message: "fake", time: "yesterday" });

    expect(lastJson(info)).toMatchObject({ level: "info", message: "real" });
    expect(lastJson(info).time).not.toBe("yesterday");
  });

  it("child loggers stamp bindings and let call context extend them", () => {
    const log = logger.child({ requestId: "r-1" });
    log.info("hello", { step: 2 });

    expect(lastJson(info)).toMatchObject({ requestId: "r-1", step: 2 });
  });

  it("forwards only real Error objects at error level to Sentry", () => {
    const failure = new Error("db down");
    logger.child({ requestId: "r-9" }).error("query failed", { error: failure });
    logger.error("string only", { error: "just text" });
    logger.warn("not an error", { error: new Error("warn") });

    expect(captureServerError).toHaveBeenCalledTimes(1);
    expect(captureServerError).toHaveBeenCalledWith(failure, { requestId: "r-9" });
  });

  it("prints a readable line outside JSON mode", () => {
    vi.stubEnv("LOG_FORMAT", "pretty");
    logger.warn("careful", { id: 3 });

    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toMatch(/WARN\s+careful \{"id":3\}$/);
  });
});
