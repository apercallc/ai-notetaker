import { prisma } from "./db";
import { ValidationError } from "./meetings";
import { enqueueManagedJob } from "./managedJobs";
import { managedHostingEnabled } from "./managedAuth";
import { runManagedJob } from "./managedWorker";

export type RetryResult = { ok: true } | { ok: false; error: string };

/**
 * Re-run hosted processing for a meeting whose latest job failed.
 *
 * `enqueueManagedJob` already knows how to revive an errored job under the
 * same idempotency key (it re-reserves usage, which the failed run released),
 * so this reuses the recording that was uploaded rather than asking the
 * capture client to send it again. Dispatch mirrors the process route: fire
 * and forget when MANAGED_WORKER_TOKEN is configured, otherwise the
 * always-on worker's poll picks the queued job up.
 */
export async function retryMeetingProcessing(workspaceId: string, meetingId: string): Promise<RetryResult> {
  if (!managedHostingEnabled()) return { ok: false, error: "Hosted processing isn't enabled on this instance." };

  const job = await prisma.processingJob.findFirst({
    where: { workspaceId, meetingId },
    orderBy: { createdAt: "desc" },
    select: { id: true, uploadId: true, idempotencyKey: true, status: true },
  });
  if (!job) return { ok: false, error: "There's no hosted processing to retry for this meeting." };
  if (job.status === "queued" || job.status === "processing") return { ok: true };
  if (job.status !== "error") return { ok: false, error: "This meeting was already processed." };

  try {
    const revived = await enqueueManagedJob(workspaceId, meetingId, job.uploadId, job.idempotencyKey);
    if (process.env.MANAGED_WORKER_TOKEN) {
      void runManagedJob(workspaceId, revived.id).catch((error: unknown) => {
        console.error("managed job retry failed", {
          jobId: revived.id,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.message };
    if (error instanceof Error && error.message.includes("entitlement is unavailable")) {
      return { ok: false, error: "Your plan has no hosted processing left. See Plans & usage." };
    }
    console.error("managed job retry could not be queued", {
      meetingId,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Couldn't restart processing. Try again in a moment." };
  }
}
