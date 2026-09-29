import { describe, expect, it, vi } from "vitest";
import { ManagedWorkerRequestError, nextErrorDelay, pollOnce, workerConfig } from "./managed-worker.mjs";

describe("managed worker runner", () => {
  it("requires the worker token and applies bounded polling configuration", () => {
    expect(() => workerConfig({})).toThrow("MANAGED_WORKER_TOKEN is required");
    expect(workerConfig({ MANAGED_WORKER_TOKEN: "worker", MANAGED_WORKER_POLL_MS: "1" })).toMatchObject({ pollMs: 250 });
    expect(workerConfig({ MANAGED_WORKER_TOKEN: "worker", MANAGED_WORKER_POLL_MS: "999999" })).toMatchObject({ pollMs: 60_000 });
    expect(nextErrorDelay(5_000, 10_000)).toBe(10_000);
    expect(nextErrorDelay(10_000, 10_000)).toBe(20_000);
    expect(nextErrorDelay(60_000, 10_000)).toBe(60_000);
  });

  it("treats an empty poll as idle and sends only the worker token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(pollOnce({ baseUrl: "http://webapp:3000", token: "secret", fetchImpl })).resolves.toEqual({ status: "idle" });
    expect(fetchImpl).toHaveBeenCalledWith("http://webapp:3000/api/v1/jobs/next", { method: "POST", headers: { "x-worker-token": "secret" } });
  });

  it("surfaces non-success responses without exposing a retry as success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(pollOnce({ baseUrl: "http://webapp:3000", token: "wrong", fetchImpl })).rejects.toEqual(expect.any(ManagedWorkerRequestError));
  });

  it("sends only allowlisted worker failure labels to Sentry", async () => {
    const priorDsn = process.env.SENTRY_DSN;
    const sentry = {
      init: vi.fn(),
      captureException: vi.fn(),
      flush: vi.fn().mockResolvedValue(true),
    };
    vi.resetModules();
    vi.doMock("@sentry/nextjs", () => sentry);
    process.env.SENTRY_DSN = "https://example.invalid/123";
    try {
      const worker = await import("./managed-worker.mjs");
      const rawError = new worker.ManagedWorkerRequestError("private transcript, signed URL https://example.test/?token=secret", 503);
      rawError.stack = "private stack with provider response";
      worker.reportWorkerError(rawError, { phase: "poll", email: "person@example.test", transcript: "private meeting" });

      expect(sentry.captureException).toHaveBeenCalledOnce();
      const [reportedError, options] = sentry.captureException.mock.calls[0];
      expect(reportedError).toEqual({ name: "ManagedWorkerRequestError", message: "Managed worker poll failure" });
      expect(options).toEqual({ tags: { workerPhase: "poll", errorClass: "ManagedWorkerRequestError", httpStatus: "503" } });
      expect(JSON.stringify([reportedError, options])).not.toMatch(/private|secret|person@example|transcript/);

      const beforeSend = sentry.init.mock.calls[0][0].beforeSend;
      const event = beforeSend({
        message: "private provider response",
        user: { email: "person@example.test" },
        request: { url: "https://example.test/?token=secret", data: "private body" },
        extra: { transcript: "private meeting" },
        breadcrumbs: [{ message: "private breadcrumb" }],
        tags: { workerPhase: "poll", errorClass: "ManagedWorkerRequestError", httpStatus: "503", workspaceId: "private" },
        exception: { values: [{ type: "ManagedWorkerRequestError", value: "private exception", stacktrace: { frames: [{ filename: "private URL" }] } }] },
      });
      expect(event).toEqual({
        tags: { workerPhase: "poll", errorClass: "ManagedWorkerRequestError", httpStatus: "503" },
        exception: { values: [{ type: "ManagedWorkerRequestError", value: "Managed worker failure" }] },
        message: "Managed worker failure",
      });
      expect(JSON.stringify(event)).not.toMatch(/private|secret|person@example|transcript/);
    } finally {
      vi.doUnmock("@sentry/nextjs");
      vi.resetModules();
      if (priorDsn === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = priorDsn;
    }
  });
});
