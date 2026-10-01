import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./db";
import { getUpload, ManagedValidationError, MAX_CHUNK_BYTES } from "./managedJobs";
import { directUploadsEnabled, getObject, signDirectUpload } from "./objectStorage";

function indexFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) throw new ManagedValidationError("chunk index is invalid");
  return Number(raw);
}

/** Authenticated caller supplies only its resolved workspace; never an object key. */
export async function prepareDirectUpload(workspaceId: string, uploadId: string, rawIndex: string, body: Record<string, unknown>) {
  const chunkIndex = indexFrom(rawIndex);
  const byteLength = body.byteLength;
  const checksum = body.checksum;
  const channel = body.channel;
  if (!directUploadsEnabled()) throw new ManagedValidationError("direct uploads are disabled");
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_CHUNK_BYTES ||
    typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum) || (channel !== "mic" && channel !== "speaker")) {
    throw new ManagedValidationError("chunk metadata is invalid");
  }
  const ticket = await prisma.$transaction(async (tx) => {
    const writable = await tx.managedUpload.updateMany({
      where: { id: uploadId, workspaceId, status: { in: ["created", "uploading"] }, expiresAt: { gt: new Date() } }, data: { status: "uploading" },
    });
    if (!writable.count) throw new ManagedValidationError("upload session expired or unavailable");
    const upload = await tx.managedUpload.findUniqueOrThrow({ where: { id: uploadId } });
    if (chunkIndex >= upload.totalChunks) throw new ManagedValidationError("chunk index is outside the manifest");
    const existing = await tx.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
    const reserved = await tx.directUploadTicket.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
    const prior = existing ?? reserved;
    if (prior && (prior.checksum !== checksum || prior.byteLength !== byteLength || prior.channel !== channel)) throw new ManagedValidationError("chunk conflicts with an existing retry");
    if (existing) return null;
    if (reserved) return { ...reserved, expiresAt: upload.expiresAt };
    const stored = await tx.uploadChunk.aggregate({ where: { uploadId }, _sum: { byteLength: true } });
    const pending = await tx.directUploadTicket.aggregate({ where: { uploadId }, _sum: { byteLength: true } });
    if ((stored._sum.byteLength ?? 0) + (pending._sum.byteLength ?? 0) + byteLength > upload.totalBytes) throw new ManagedValidationError("uploaded chunks exceed the declared upload byte limit");
    const created = await tx.directUploadTicket.create({ data: { uploadId, chunkIndex, byteLength, checksum, channel, objectKey: `uploads/${workspaceId}/${uploadId}/direct-${randomUUID()}` } });
    return { ...created, expiresAt: upload.expiresAt };
  });
  if (!ticket) return { replayed: true };
  const expiresIn = Math.min(120, Math.floor((ticket.expiresAt.getTime() - Date.now()) / 1_000));
  if (expiresIn < 1) throw new ManagedValidationError("upload session expired");
  // Keep the object until outstanding URLs expire. Deleting it sooner would
  // allow the conditional URL to create it again after successful processing.
  // Include a grace window for PUTs begun just before signature expiration.
  await prisma.$transaction(async (tx) => {
    const writable = await tx.managedUpload.updateMany({ where: { id: uploadId, workspaceId, status: { in: ["created", "uploading"] }, expiresAt: { gt: new Date() } }, data: { status: "uploading" } });
    if (!writable.count) throw new ManagedValidationError("upload session expired or unavailable");
    const renewed = await tx.directUploadTicket.updateMany({ where: { id: ticket.id }, data: { signedUntil: new Date(Date.now() + (expiresIn + 120) * 1_000) } });
    if (!renewed.count) throw new ManagedValidationError("chunk was completed; retry the manifest");
  });
  return { ...(await signDirectUpload(ticket.objectKey, ticket.byteLength, expiresIn)), replayed: false };
}

export async function completeDirectChunk(workspaceId: string, uploadId: string, rawIndex: string) {
  const chunkIndex = indexFrom(rawIndex);
  const upload = await getUpload(workspaceId, uploadId);
  if (!upload || upload.status === "expired" || upload.expiresAt <= new Date()) throw new ManagedValidationError("upload session expired or unavailable");
  const ticket = await prisma.directUploadTicket.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
  const existing = await prisma.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
  if (existing && !ticket) return { replayed: true };
  if (!ticket) throw new ManagedValidationError("no direct upload reservation");
  // Do not trust user metadata or an ETag as a SHA-256. Verify stored bytes.
  // If-None-Match in the signature prevents later replay overwrites.
  const bytes = await getObject(ticket.objectKey);
  if (bytes.byteLength !== ticket.byteLength || createHash("sha256").update(bytes).digest("hex") !== ticket.checksum) throw new ManagedValidationError("stored chunk checksum or size mismatch");
  await prisma.$transaction(async (tx) => {
    const writable = await tx.managedUpload.updateMany({ where: { id: uploadId, workspaceId, status: { in: ["created", "uploading"] }, expiresAt: { gt: new Date() } }, data: { status: "uploading" } });
    if (!writable.count) throw new ManagedValidationError("upload session expired or unavailable");
    const prior = await tx.uploadChunk.findUnique({ where: { uploadId_chunkIndex: { uploadId, chunkIndex } } });
    const currentTicket = await tx.directUploadTicket.findUnique({ where: { id: ticket.id } });
    if (prior && (prior.checksum !== ticket.checksum || prior.byteLength !== ticket.byteLength || prior.channel !== ticket.channel)) throw new ManagedValidationError("chunk conflicts with an existing retry");
    if (!prior) {
      if (!currentTicket) throw new ManagedValidationError("direct upload reservation is no longer available");
      await tx.uploadChunk.create({ data: { uploadId, chunkIndex, checksum: ticket.checksum, byteLength: ticket.byteLength, channel: ticket.channel, objectKey: ticket.objectKey, signedUntil: currentTicket.signedUntil } });
    }
    await tx.directUploadTicket.deleteMany({ where: { id: ticket.id } });
  });
  return { replayed: Boolean(existing) };
}
