import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getBrowserManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { assertImportUpload } from "@/lib/fileImport";
import { handleManagedChunkUpload } from "@/lib/managedUploadChunk";

export async function PUT(request: Request, context: { params: Promise<{ uploadId: string; chunkIndex: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getBrowserManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { uploadId, chunkIndex } = await context.params;
    // Only import uploads: this cookie-authenticated route never writes into a live-capture upload.
    await assertImportUpload(session.workspaceId, uploadId);
    return await handleManagedChunkUpload(request, session.workspaceId, uploadId, chunkIndex, requestId);
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
