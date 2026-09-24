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
});
