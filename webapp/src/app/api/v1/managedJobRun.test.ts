import { beforeEach, describe, expect, it, vi } from "vitest";

const { runManagedJob, isBenignJobRace, captureServerError } = vi.hoisted(() => ({
  runManagedJob: vi.fn(),
  isBenignJobRace: vi.fn((_error: unknown) => false),
  captureServerError: vi.fn(),
}));

vi.mock("@/lib/managedWorker", () => ({ runManagedJob, isBenignJobRace }));
vi.mock("@/lib/observability", () => ({ captureServerError }));

import { POST } from "./jobs/[jobId]/run/route";

const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/v1/jobs/job-1/run", {
  method: "POST",
  headers: { "x-request-id": "job-run-test", ...headers },
});
const context = { params: Promise.resolve({ jobId: "job-1" }) };
const workerHeaders = { "x-worker-token": "worker-secret", "x-workspace-id": "workspace-1" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MANAGED_HOSTING = "true";
  process.env.MANAGED_WORKER_TOKEN = "worker-secret";
});

describe("managed worker job run route", () => {
  it("is unavailable on self-hosted deployments and authenticates workers", async () => {
    delete process.env.MANAGED_HOSTING;
    const disabled = await POST(request(workerHeaders), context);
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: "managed hosting is disabled", requestId: "job-run-test" });

    process.env.MANAGED_HOSTING = "true";
    const denied = await POST(request({ "x-worker-token": "wrong", "x-workspace-id": "workspace-1" }), context);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "worker authentication required", requestId: "job-run-test" });
    expect(denied.headers.get("x-request-id")).toBe("job-run-test");
    expect(runManagedJob).not.toHaveBeenCalled();
  });

  it("requires workspace scope and dispatches successful work to the managed processor", async () => {
    const missingWorkspace = await POST(request({ "x-worker-token": "worker-secret" }), context);
    expect(missingWorkspace.status).toBe(400);
    expect(await missingWorkspace.json()).toEqual({ error: "workspace is required", requestId: "job-run-test" });

    runManagedJob.mockResolvedValue(undefined);
    const response = await POST(request(workerHeaders), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("job-run-test");
    expect(await response.json()).toEqual({ jobId: "job-1", status: "complete" });
    expect(runManagedJob).toHaveBeenCalledWith("workspace-1", "job-1");
  });

  it("answers 409, without alerting, when the poller already claimed the job", async () => {
    runManagedJob.mockRejectedValue(new Error("managed job not found or already running"));
    isBenignJobRace.mockReturnValueOnce(true);
    const response = await POST(request(workerHeaders), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ jobId: "job-1", status: "already-running" });
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("returns a correlated safe error and reports processor failures", async () => {
    const error = new Error("provider secret must not be returned to worker callers");
    runManagedJob.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request(workerHeaders), context);
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("job-run-test");
    const body = await response.json();
    expect(body).toEqual({ error: "managed processing failed", requestId: "job-run-test" });
    expect(JSON.stringify(body)).not.toContain("provider secret");
    expect(captureServerError).toHaveBeenCalledWith(error, expect.objectContaining({
      requestId: "job-run-test", workspaceId: "workspace-1", jobId: "job-1", path: "managed-job-run",
    }));
    expect(log).toHaveBeenCalledWith("managed job request failed", expect.objectContaining({ error: error.message }));
    log.mockRestore();
  });
});
