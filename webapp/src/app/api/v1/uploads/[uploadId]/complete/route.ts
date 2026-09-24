import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { completeManagedUpload } from "@/lib/managedJobs";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { uploadId } = await context.params;
    const upload = await completeManagedUpload(session.workspaceId, uploadId);
    return NextResponse.json({ uploadId: upload.id, status: upload.status, completedAt: upload.completedAt }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
