import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, enqueueManagedJob, runManagedJob, managedHostingEnabled } = vi.hoisted(() => ({
  findFirst: vi.fn(), enqueueManagedJob: vi.fn(), runManagedJob: vi.fn(), managedHostingEnabled: vi.fn(),
}));
vi.mock("./db", () => ({ prisma: { processingJob: { findFirst } } }));
vi.mock("./managedJobs", () => ({ enqueueManagedJob }));
vi.mock("./managedAuth", () => ({ managedHostingEnabled }));
vi.mock("./managedWorker", () => ({ runManagedJob }));
vi.mock("./meetings", () => ({ ValidationError: class ValidationError extends Error {} }));

import { retryMeetingProcessing } from "./meetingProcessing";
import { ValidationError } from "./meetings";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MANAGED_WORKER_TOKEN;
  managedHostingEnabled.mockReturnValue(true);
  findFirst.mockResolvedValue({
    id: "job-1",
    uploadId: "upload-1",
    idempotencyKey: "meeting-1",
    status: "error",
    upload: { status: "complete", expiresAt: new Date(Date.now() + 60_000) },
  });
  enqueueManagedJob.mockResolvedValue({ id: "job-2" });
  runManagedJob.mockResolvedValue(undefined);
});

describe("retry failed hosted meeting processing", () => {
  it("reports disabled, missing, active, and already-finished jobs without enqueueing", async () => {
    managedHostingEnabled.mockReturnValue(false);
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: false, error: "Hosted processing isn't enabled on this instance." });
    managedHostingEnabled.mockReturnValue(true);
    findFirst.mockResolvedValueOnce(null);
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: false, error: "There's no hosted processing to retry for this meeting." });
    findFirst.mockResolvedValueOnce({ status: "queued" });
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: true });
    findFirst.mockResolvedValueOnce({ status: "processing" });
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: true });
    findFirst.mockResolvedValueOnce({ status: "complete" });
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: false, error: "This meeting was already processed." });
    expect(enqueueManagedJob).not.toHaveBeenCalled();
  });

  it("directs the user to retry locally after temporary audio staging expires", async () => {
    findFirst.mockResolvedValueOnce({
      id: "job-1",
      uploadId: "upload-1",
      idempotencyKey: "meeting-1",
      status: "error",
      upload: { status: "expired", expiresAt: new Date(Date.now() - 1) },
    });
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({
      ok: false,
      error: "The temporary upload expired. Retry from the extension or desktop helper while its local recording is still available.",
    });
    expect(enqueueManagedJob).not.toHaveBeenCalled();
  });

  it("revives an errored job with its original idempotency key and can dispatch immediately", async () => {
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: true });
    expect(enqueueManagedJob).toHaveBeenCalledWith("workspace-1", "meeting-1", "upload-1", "meeting-1");
    expect(runManagedJob).not.toHaveBeenCalled();

    process.env.MANAGED_WORKER_TOKEN = "worker-secret";
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: true });
    expect(runManagedJob).toHaveBeenCalledWith("workspace-1", "job-2");
  });

  it("maps validation, entitlement, and unexpected enqueue failures to safe messages", async () => {
    enqueueManagedJob.mockRejectedValueOnce(new ValidationError("recording is incomplete"));
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: false, error: "recording is incomplete" });

    enqueueManagedJob.mockRejectedValueOnce(new Error("workspace entitlement is unavailable"));
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: false, error: "Your plan has no hosted processing left. See Plans & usage." });

    const error = new Error("internal provider details");
    enqueueManagedJob.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: false, error: "Couldn't restart processing. Try again in a moment." });
    expect(log).toHaveBeenCalledWith("managed job retry could not be queued", expect.objectContaining({ error: error.message }));
    log.mockRestore();
  });

  it("records a rejected fire-and-forget dispatch without turning a queued retry into an error", async () => {
    process.env.MANAGED_WORKER_TOKEN = "worker-secret";
    runManagedJob.mockRejectedValue(new Error("worker unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await retryMeetingProcessing("workspace-1", "meeting-1")).toEqual({ ok: true });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("managed job retry failed", expect.objectContaining({ jobId: "job-2" })));
    log.mockRestore();
  });
});
