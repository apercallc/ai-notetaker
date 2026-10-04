import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchManagedJob } from "./managedDispatch";

describe("managed worker dispatch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps database polling as the default and when the worker token is missing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    dispatchManagedJob("job-1", "workspace-1");
    vi.stubEnv("MANAGED_WORKER_MODE", "http");
    dispatchManagedJob("job-2", "workspace-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches only to the configured worker with the scoped credentials", () => {
    vi.stubEnv("MANAGED_WORKER_MODE", "http");
    vi.stubEnv("MANAGED_WORKER_TOKEN", "worker-secret");
    vi.stubEnv("WORKER_URL", "https://worker.example.test/base-path");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    dispatchManagedJob("job/1", "workspace-1");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://worker.example.test/api/v1/jobs/job%2F1/run"),
      {
        method: "POST",
        headers: {
          "x-worker-token": "worker-secret",
          "x-workspace-id": "workspace-1",
        },
      },
    );
  });

  it("leaves the job queued when worker URL configuration is invalid", () => {
    vi.stubEnv("MANAGED_WORKER_MODE", "http");
    vi.stubEnv("MANAGED_WORKER_TOKEN", "worker-secret");
    vi.stubEnv("WORKER_URL", "file:///tmp/worker");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatchManagedJob("job-1", "workspace-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("managed job dispatch skipped: worker URL is not configured", {
      jobId: "job-1",
      workspaceId: "workspace-1",
      error: "WORKER_URL must be an http(s) URL",
    });
  });

  it("keeps the queued job available to polling after a network failure", async () => {
    vi.stubEnv("MANAGED_WORKER_MODE", "http");
    vi.stubEnv("MANAGED_WORKER_TOKEN", "worker-secret");
    vi.stubEnv("WORKER_URL", "https://worker.example.test");
    const fetchMock = vi.fn().mockRejectedValue(new Error("private transport detail"));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatchManagedJob("job-1", "workspace-1");
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());

    expect(log).toHaveBeenCalledWith("managed job dispatch failed", {
      jobId: "job-1",
      workspaceId: "workspace-1",
      error: "private transport detail",
    });
  });
});
