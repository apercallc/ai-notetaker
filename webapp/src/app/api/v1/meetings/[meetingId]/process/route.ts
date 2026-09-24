import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
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
    dispatchManagedJob(request, job.id, session.workspaceId);
    return NextResponse.json({ jobId: job.id, meetingId: job.meetingId, status: job.status }, { status: 202, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}

function dispatchManagedJob(request: Request, jobId: string, workspaceId: string): void {
  const workerToken = process.env.MANAGED_WORKER_TOKEN;
  if (!workerToken) return;
  const url = new URL(`/api/v1/jobs/${encodeURIComponent(jobId)}/run`, request.url);
  void fetch(url, {
    method: "POST",
    headers: { "x-worker-token": workerToken, "x-workspace-id": workspaceId },
  }).catch((error) => {
    console.error("managed job dispatch failed", { jobId, workspaceId, error: error instanceof Error ? error.message : String(error) });
  });
}
