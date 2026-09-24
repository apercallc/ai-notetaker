import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { createManagedUpload, ManagedValidationError, readManagedJson } from "@/lib/managedJobs";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    const upload = await createManagedUpload(session.workspaceId, {
      meetingId: typeof value.meetingId === "string" ? value.meetingId : "",
      totalChunks: typeof value.totalChunks === "number" ? value.totalChunks : NaN,
      totalBytes: typeof value.totalBytes === "number" ? value.totalBytes : NaN,
      idempotencyKey: typeof value.idempotencyKey === "string" ? value.idempotencyKey : "",
    });
    return NextResponse.json(
      {
        uploadId: upload.id,
        meetingId: upload.meetingId,
        status: upload.status,
        totalChunks: upload.totalChunks,
        totalBytes: upload.totalBytes,
        chunks: upload.chunks,
      },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
