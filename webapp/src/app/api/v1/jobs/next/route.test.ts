import { beforeEach, describe, expect, it, vi } from "vitest";

const { nextManagedJob, runManagedJob, isBenignJobRace, managedHostingEnabled, isValidWorkerToken, apiErrorResponse } = vi.hoisted(() => ({
  nextManagedJob: vi.fn(),
  runManagedJob: vi.fn(),
  isBenignJobRace: vi.fn((_error: unknown) => false),
  managedHostingEnabled: vi.fn(() => true),
  isValidWorkerToken: vi.fn((_token: string | null) => true),
  apiErrorResponse: vi.fn((_error: unknown, options: { requestId?: string }) =>
    Response.json({ error: "internal server error", requestId: options.requestId }, { status: 500 }),
  ),
}));

vi.mock("@/lib/managedWorker", () => ({ nextManagedJob, runManagedJob, isBenignJobRace }));
vi.mock("@/lib/managedAuth", () => ({ managedHostingEnabled }));
vi.mock("@/lib/secureCompare", () => ({ isValidWorkerToken }));
vi.mock("@/lib/apiErrors", () => ({ requestIdFrom: (request: Request) => request.headers.get("x-request-id") ?? "generated-id", apiErrorResponse }));

import { POST } from "./route";

const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/v1/jobs/next", {
  method: "POST",
  headers: { "x-request-id": "worker-poll-test", "x-worker-token": "worker-secret", ...headers },
});

beforeEach(() => {
  vi.clearAllMocks();
  managedHostingEnabled.mockReturnValue(true);
  isValidWorkerToken.mockReturnValue(true);
  isBenignJobRace.mockReturnValue(false);
});

describe("managed worker poll route", () => {
  it("rejects disabled deployments and unauthenticated workers before queue access", async () => {
    managedHostingEnabled.mockReturnValue(false);
    const disabled = await POST(request());
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: "managed hosting is disabled", requestId: "worker-poll-test" });

    managedHostingEnabled.mockReturnValue(true);
    isValidWorkerToken.mockReturnValue(false);
    const unauthorized = await POST(request());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("x-request-id")).toBe("worker-poll-test");
    expect(await unauthorized.json()).toEqual({ error: "worker authentication required", requestId: "worker-poll-test" });
    expect(nextManagedJob).not.toHaveBeenCalled();
  });

  it("runs only the database-selected workspace job and returns an empty idle response", async () => {
    nextManagedJob.mockResolvedValueOnce({ jobId: "job-1", workspaceId: "workspace-from-database" }).mockResolvedValueOnce(null);

    const claimed = await POST(request({ "x-workspace-id": "attacker-selected-workspace" }));
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get("x-request-id")).toBe("worker-poll-test");
    expect(await claimed.json()).toEqual({ jobId: "job-1", workspaceId: "workspace-from-database", status: "complete" });
    expect(runManagedJob).toHaveBeenCalledWith("workspace-from-database", "job-1");

    const idle = await POST(request());
    expect(idle.status).toBe(204);
    expect(idle.headers.get("x-request-id")).toBe("worker-poll-test");
    expect(await idle.text()).toBe("");
  });

  it("treats a concurrent claim as idle and sends unexpected failures through the safe API handler", async () => {
    const race = new Error("job already claimed");
    nextManagedJob.mockRejectedValueOnce(race);
    isBenignJobRace.mockReturnValueOnce(true);
    const raced = await POST(request());
    expect(raced.status).toBe(204);
    expect(await raced.text()).toBe("");
    expect(apiErrorResponse).not.toHaveBeenCalled();

    const failure = new Error("database connection detail");
    nextManagedJob.mockRejectedValueOnce(failure);
    const errored = await POST(request());
    expect(errored.status).toBe(500);
    expect(apiErrorResponse).toHaveBeenCalledWith(failure, { requestId: "worker-poll-test" });
  });
});
