import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { workerJobRunUrl } from "@/lib/deploymentConfig";
import { enqueueManagedJob, ManagedValidationError, readManagedJson } from "@/lib/managedJobs";

export async function POST(request: Request, context: { params: Promise<{ meetingId: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { meetingId } = await context.params;
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    const job = await enqueueManagedJob(
      session.workspaceId,
      meetingId,
      typeof value.uploadId === "string" ? value.uploadId : "",
      typeof value.idempotencyKey === "string" ? value.idempotencyKey : "",
    );
    // Only a freshly queued job needs a push; an already-complete or running
    // replay must not trigger a pointless (and failing) second run request.
    if (job.status === "queued") dispatchManagedJob(job.id, session.workspaceId);
    return NextResponse.json({ jobId: job.id, meetingId: job.meetingId, status: job.status }, { status: 202, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}

function dispatchManagedJob(jobId: string, workspaceId: string): void {
  const workerToken = process.env.MANAGED_WORKER_TOKEN;
  if (!workerToken) return;
  // The target comes from WORKER_URL/APP_URL configuration, never from the
  // request URL or Host header, which the caller controls. If it cannot be
  // resolved the job simply stays queued for the polling worker.
  let url: URL;
  try {
    url = workerJobRunUrl(jobId);
  } catch (error) {
    console.error("managed job dispatch skipped: worker URL is not configured", { jobId, workspaceId, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  void fetch(url, {
    method: "POST",
    headers: { "x-worker-token": workerToken, "x-workspace-id": workspaceId },
  }).catch((error) => {
    console.error("managed job dispatch failed", { jobId, workspaceId, error: error instanceof Error ? error.message : String(error) });
  });
}
