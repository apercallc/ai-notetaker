import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { ManagedValidationError, readManagedJson } from "@/lib/managedJobs";
import { prepareDirectUpload, completeDirectChunk } from "@/lib/directUpload";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string; chunkIndex: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { uploadId, chunkIndex } = await context.params;
    const body = await readManagedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ManagedValidationError("invalid chunk metadata");
    const value = body as Record<string, unknown>;
    const result = value.operation === "complete"
      ? await completeDirectChunk(session.workspaceId, uploadId, chunkIndex)
      : await prepareDirectUpload(session.workspaceId, uploadId, chunkIndex, value);
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) { return apiErrorResponse(error, { requestId }); }
}
