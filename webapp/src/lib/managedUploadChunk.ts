import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "./db";
import { apiErrorResponse, jsonError } from "./apiErrors";
import { getUpload, MAX_CHUNK_BYTES, ManagedValidationError, readManagedBytes } from "./managedJobs";
import { chunkObjectKey, deleteObject, putObject } from "./objectStorage";

/**
 * Stores one chunk of a managed upload. Shared by the extension/helper API
 * (Bearer session) and the browser import API (cookie session): both
 * authenticate before calling this, and neither passes anything but the
 * workspace their session resolved to.
 */
export async function handleManagedChunkUpload(
  request: Request,
  workspaceId: string,
  uploadId: string,
  rawIndex: string,
  requestId: string,
): Promise<Response> {
  try {
    // Number() also accepts " 1", "1e0" and "0x1", which would alias the same chunk under several spellings.
    const chunkIndex = /^\d{1,9}$/.test(rawIndex) ? Number(rawIndex) : Number.NaN;
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new ManagedValidationError("chunk index is invalid");
    const bytes = await readManagedBytes(request, MAX_CHUNK_BYTES);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) throw new ManagedValidationError("chunk size is invalid");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const channel = request.headers.get("x-audio-channel") ?? "speaker";
    if (channel !== "mic" && channel !== "speaker") throw new ManagedValidationError("audio channel is invalid");
    const suppliedChecksum = request.headers.get("x-chunk-sha256");
    if (!suppliedChecksum || suppliedChecksum.toLowerCase() !== checksum) return jsonError("chunk checksum mismatch", 400, requestId);

    const upload = await getUpload(workspaceId, uploadId);
    if (!upload) return jsonError("upload not found", 404, requestId);
    if (chunkIndex >= upload.totalChunks) throw new ManagedValidationError("chunk index is outside the manifest");
    if (upload.status === "complete") throw new ManagedValidationError("upload is already complete");
    if (upload.status === "expired") throw new ManagedValidationError("upload session expired; start the upload again");

    const existing = await prisma.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
    if (existing) {
      if (existing.checksum !== checksum || existing.byteLength !== bytes.byteLength || existing.channel !== channel) return jsonError("chunk conflicts with an existing retry", 409, requestId);
      return NextResponse.json({ uploadId, chunkIndex, checksum, byteLength: bytes.byteLength, replayed: true }, { headers: { "x-request-id": requestId } });
    }

    // Each request owns its staged object until its row commits. Concurrent
    // retries can have identical bytes (including silent mic/speaker audio),
    // so a deterministic shared key lets a losing request delete the winner.
    const objectKey = `${chunkObjectKey(workspaceId, uploadId, chunkIndex, checksum)}-${randomUUID()}`;
    await putObject(objectKey, bytes);
    try {
      const inserted = await prisma.$transaction(async (tx) => {
        // Expiry cleanup and chunk writes serialize on the upload row. A
        // cleanup pass that wins this race leaves the upload expired instead
        // of allowing a stale request to resurrect it as "uploading".
        const writable = await tx.managedUpload.updateMany({
          where: { id: uploadId, status: { in: ["created", "uploading"] }, expiresAt: { gt: new Date() } },
          data: { status: "uploading" },
        });
        if (writable.count !== 1) throw new ManagedValidationError("upload session expired; start the upload again");
        // Recheck after acquiring the upload-row lock. A parallel retry may
        // have committed since the earlier optimistic read above.
        const concurrent = await tx.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
        if (concurrent) {
          if (concurrent.checksum !== checksum || concurrent.byteLength !== bytes.byteLength || concurrent.channel !== channel) {
            throw new ManagedValidationError("chunk conflicts with an existing retry");
          }
          return false;
        }
        if (await tx.directUploadTicket.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } })) {
          throw new ManagedValidationError("chunk has a direct upload reservation; finish the direct upload");
        }
        // The upload-row update above is the per-upload serialization point:
        // concurrent chunk requests lock the same row before summing, so they
        // cannot each observe spare manifest capacity and exceed it together.
        const stored = await tx.uploadChunk.aggregate({
          where: { uploadId },
          _sum: { byteLength: true },
        });
        const pending = await tx.directUploadTicket.aggregate({ where: { uploadId }, _sum: { byteLength: true } });
        if ((stored._sum.byteLength ?? 0) + (pending._sum.byteLength ?? 0) + bytes.byteLength > upload.totalBytes) {
          throw new ManagedValidationError("uploaded chunks exceed the declared upload byte limit");
        }
        await tx.uploadChunk.create({ data: { uploadId, chunkIndex, channel, byteLength: bytes.byteLength, checksum, objectKey } });
        return true;
      });
      if (!inserted) {
        await deleteObject(objectKey);
        return NextResponse.json({ uploadId, chunkIndex, checksum, byteLength: bytes.byteLength, replayed: true }, { headers: { "x-request-id": requestId } });
      }
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
        await deleteObject(objectKey);
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
