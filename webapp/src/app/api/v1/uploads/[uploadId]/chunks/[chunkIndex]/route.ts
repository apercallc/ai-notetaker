import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { getUpload, MAX_CHUNK_BYTES, ManagedValidationError, readManagedBytes } from "@/lib/managedJobs";
import { chunkObjectKey, deleteObject, putObject } from "@/lib/objectStorage";

export async function PUT(request: Request, context: { params: Promise<{ uploadId: string; chunkIndex: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { uploadId, chunkIndex: rawIndex } = await context.params;
    const chunkIndex = Number(rawIndex);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new ManagedValidationError("chunk index is invalid");
    const bytes = await readManagedBytes(request, MAX_CHUNK_BYTES);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) throw new ManagedValidationError("chunk size is invalid");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const channel = request.headers.get("x-audio-channel") ?? "speaker";
    if (channel !== "mic" && channel !== "speaker") throw new ManagedValidationError("audio channel is invalid");
    const suppliedChecksum = request.headers.get("x-chunk-sha256");
    if (!suppliedChecksum || suppliedChecksum !== checksum) return jsonError("chunk checksum mismatch", 400, requestId);

    const upload = await getUpload(session.workspaceId, uploadId);
    if (!upload) return jsonError("upload not found", 404, requestId);
    if (chunkIndex >= upload.totalChunks) throw new ManagedValidationError("chunk index is outside the manifest");
    if (upload.status === "complete") throw new ManagedValidationError("upload is already complete");
    if (upload.status === "expired") throw new ManagedValidationError("upload session expired; start the upload again");

    const existing = await prisma.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
    if (existing) {
      if (existing.checksum !== checksum || existing.byteLength !== bytes.byteLength || existing.channel !== channel) return jsonError("chunk conflicts with an existing retry", 409, requestId);
      return NextResponse.json({ uploadId, chunkIndex, checksum, byteLength: bytes.byteLength, replayed: true }, { headers: { "x-request-id": requestId } });
    }

    const objectKey = chunkObjectKey(session.workspaceId, uploadId, chunkIndex, checksum);
    await putObject(objectKey, bytes);
    try {
      await prisma.$transaction(async (tx) => {
        // Expiry cleanup and chunk writes serialize on the upload row. A
        // cleanup pass that wins this race leaves the upload expired instead
        // of allowing a stale request to resurrect it as "uploading".
        const writable = await tx.managedUpload.updateMany({
          where: { id: uploadId, status: { in: ["created", "uploading"] }, expiresAt: { gt: new Date() } },
          data: { status: "uploading" },
        });
        if (writable.count !== 1) throw new ManagedValidationError("upload session expired; start the upload again");
        await tx.uploadChunk.create({ data: { uploadId, chunkIndex, channel, byteLength: bytes.byteLength, checksum, objectKey } });
      });
    } catch (error) {
      // The object was written before the transaction; if the row never
      // committed (expiry race, transient DB error), no record points at the
      // stored bytes — nothing would ever clean them up. Remove the object
      // unless the losing-insert P2002 path below proves a row exists.
      if ((error as { code?: string }).code !== "P2002") {
        await deleteObject(objectKey).catch((cleanupError) => {
          console.error("managed upload chunk orphan cleanup failed", {
            requestId,
            uploadId,
            chunkIndex,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
        throw error;
      }
      // Two retries can pass the initial read before either transaction
      // commits. Treat the losing unique-constraint insert as the same
      // idempotent retry, while removing a different payload's orphaned
      // object. The normal pre-check alone cannot close this race.
      const committed = await prisma.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
      if (committed && committed.checksum === checksum && committed.byteLength === bytes.byteLength && committed.channel === channel) {
        return NextResponse.json({ uploadId, chunkIndex, checksum, byteLength: bytes.byteLength, replayed: true }, { headers: { "x-request-id": requestId } });
      }
      await deleteObject(objectKey).catch((cleanupError) => {
        console.error("managed upload race cleanup failed", {
          requestId,
          uploadId,
          chunkIndex,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
      return jsonError("chunk conflicts with an existing retry", 409, requestId);
    }
    return NextResponse.json({ uploadId, chunkIndex, checksum, byteLength: bytes.byteLength, replayed: false }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
