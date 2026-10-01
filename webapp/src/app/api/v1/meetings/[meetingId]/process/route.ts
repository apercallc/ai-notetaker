import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { dispatchManagedJob } from "@/lib/managedDispatch";
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
