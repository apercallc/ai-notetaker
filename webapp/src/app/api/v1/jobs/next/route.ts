import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { ManagedWorkerError, nextManagedJob, runManagedJob } from "@/lib/managedWorker";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { isValidWorkerToken } from "@/lib/secureCompare";

/**
 * Worker-polling endpoint for deployments without an external queue product.
 * It is protected by the same server-side worker token as the per-job route;
 * the workspace is selected from Postgres, never from caller input.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  if (!isValidWorkerToken(request.headers.get("x-worker-token"))) {
    return NextResponse.json({ error: "worker authentication required", requestId }, { status: 401, headers: { "x-request-id": requestId } });
  }

  try {
    const job = await nextManagedJob();
    // A 204 response cannot carry a JSON body. Workers treat the empty
    // response as an intentional idle poll and keep polling on their normal
    // schedule.
    if (!job) return new NextResponse(null, { status: 204, headers: { "x-request-id": requestId } });
    await runManagedJob(job.workspaceId, job.jobId);
    return NextResponse.json({ jobId: job.jobId, workspaceId: job.workspaceId, status: "complete" }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    // Another worker may have selected the same queued row between the poll
    // and the conditional claim. That is normal multi-instance contention,
    // not a failed job; return idle so the scheduler does not treat it as a
    // provider/server failure and immediately hammer the same row.
    if (error instanceof ManagedWorkerError && error.message === "job not found or already running") {
      return new NextResponse(null, { status: 204, headers: { "x-request-id": requestId } });
    }
    console.error("managed worker polling request failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return apiErrorResponse(error, { requestId });
  }
}
