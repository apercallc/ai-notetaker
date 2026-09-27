import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  initialized: false,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((callback: (scope: { setLevel: (level: string) => void; setExtra: (key: string, value: unknown) => void }) => void) => {
    callback({ setLevel: vi.fn(), setExtra: vi.fn() });
  }),
  setTag: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  isInitialized: () => sentry.initialized,
  captureException: sentry.captureException,
  captureMessage: sentry.captureMessage,
  withScope: sentry.withScope,
  setTag: sentry.setTag,
}));

import { captureServerError, captureWarning, sentryEnabled, sentryRelease, setCaptureContext } from "./observability";

const prior = {
  dsn: process.env.SENTRY_DSN,
  release: process.env.RAILWAY_GIT_COMMIT_SHA,
};

beforeEach(() => {
  vi.clearAllMocks();
  sentry.initialized = false;
  delete process.env.SENTRY_DSN;
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
});

afterAll(() => {
  if (prior.dsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = prior.dsn;
  if (prior.release === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = prior.release;
});

describe("server observability", () => {
  it("is disabled by default and ignores errors, warnings, and context without a DSN", () => {
    expect(sentryEnabled()).toBe(false);
    captureServerError(new Error("private local error"));
    captureWarning("private local warning");
    setCaptureContext({ userId: "user-1" });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(sentry.setTag).not.toHaveBeenCalled();
  });

  it("reports errors and warnings only when initialized and isolates reporter failures", () => {
    process.env.SENTRY_DSN = " https://example.invalid/123 ";
    expect(sentryEnabled()).toBe(true);
    captureServerError(new Error("before init"));
    expect(sentry.captureException).not.toHaveBeenCalled();

    sentry.initialized = true;
    const error = new Error("request failed");
    captureServerError(error, { requestId: "req-1" });
    expect(sentry.captureException).toHaveBeenCalledWith(error, { extra: { requestId: "req-1" } });
    captureWarning("retry scheduled", { attempt: 2 });
    expect(sentry.withScope).toHaveBeenCalledOnce();
    expect(sentry.captureMessage).toHaveBeenCalledWith("retry scheduled");

    sentry.captureException.mockImplementationOnce(() => { throw new Error("reporter unavailable"); });
    expect(() => captureServerError(error)).not.toThrow();
    sentry.withScope.mockImplementationOnce(() => { throw new Error("reporter unavailable"); });
    expect(() => captureWarning("also isolated")).not.toThrow();
  });

  it("sets capture tags defensively and reads the trimmed deployment release", () => {
    process.env.SENTRY_DSN = "configured";
    setCaptureContext({ deployment: "managed", region: "test" });
    expect(sentry.setTag).toHaveBeenCalledTimes(2);
    expect(sentry.setTag).toHaveBeenCalledWith("deployment", "managed");
    sentry.setTag.mockImplementationOnce(() => { throw new Error("scope unavailable"); });
    expect(() => setCaptureContext({ requestId: "safe" })).not.toThrow();

    expect(sentryRelease()).toBeUndefined();
    process.env.RAILWAY_GIT_COMMIT_SHA = " abc123 ";
    expect(sentryRelease()).toBe("abc123");
    process.env.RAILWAY_GIT_COMMIT_SHA = "  ";
    expect(sentryRelease()).toBeUndefined();
  });
});
