import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { handleManagedChunkUpload } from "@/lib/managedUploadChunk";

export async function PUT(request: Request, context: { params: Promise<{ uploadId: string; chunkIndex: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { uploadId, chunkIndex } = await context.params;
    return await handleManagedChunkUpload(request, session.workspaceId, uploadId, chunkIndex, requestId);
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
