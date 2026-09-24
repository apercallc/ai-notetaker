import { prisma } from "./db";
import { reserveMeetingProcessing } from "./usageLedger";
import { ValidationError } from "./meetings";
import { deleteObject, getObject } from "./objectStorage";
import { deleteMeeting } from "./meetings";

export class ManagedValidationError extends ValidationError {}

export const MAX_UPLOAD_CHUNKS = 10_000;
// Prisma's PostgreSQL `Int` is a signed 32-bit integer. Keep the API ceiling
// below that boundary so a valid request can never fail at persistence time.
export const MAX_UPLOAD_BYTES = 1_900_000_000;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MANAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;

function isExpired(upload: { status: string; expiresAt: Date }, now = Date.now()): boolean {
  return upload.status !== "complete" && upload.expiresAt.getTime() <= now;
}

/**
 * Read an untrusted request body without allowing a client to force an
 * arbitrarily large allocation before the size check runs. `content-length`
 * is only an early rejection; the stream limit is authoritative because
 * chunked requests do not have to provide that header.
 */
export async function readManagedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new ManagedValidationError("request body is too large");
  }

  if (!request.body) return new Uint8Array(await request.arrayBuffer());
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ManagedValidationError("request body is too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readManagedJson(request: Request): Promise<unknown> {
  const bytes = await readManagedBytes(request, MAX_METADATA_BYTES);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new ManagedValidationError("invalid JSON body");
  }
}

export async function createManagedUpload(
  workspaceId: string,
  input: { meetingId: string; totalChunks: number; totalBytes: number; idempotencyKey: string },
) {
  if (!input.meetingId || !input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new ManagedValidationError("meetingId and idempotencyKey are required");
  }
  if (!Number.isSafeInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > MAX_UPLOAD_CHUNKS) {
    throw new ManagedValidationError("totalChunks is out of range");
  }
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > MAX_UPLOAD_BYTES) {
    throw new ManagedValidationError("totalBytes is out of range");
  }

  const meeting = await prisma.meeting.findFirst({ where: { id: input.meetingId, workspaceId }, select: { id: true } });
  if (!meeting) throw new ManagedValidationError("meeting not found");

  const existing = await prisma.managedUpload.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: input.idempotencyKey } },
    include: { chunks: { select: { chunkIndex: true, byteLength: true, checksum: true, objectKey: true } } },
  });
  if (existing) {
    if (
      existing.meetingId !== input.meetingId ||
      existing.totalChunks !== input.totalChunks ||
      existing.totalBytes !== input.totalBytes
    ) {
      throw new ManagedValidationError("idempotency key conflicts with an existing upload");
    }
    if (isExpired(existing)) {
      // The helper deliberately reuses `meeting:<id>` as its idempotency key.
      // Remove an abandoned session so a later retry can start a fresh upload
      // without requiring the user to clear local helper state manually.
      await prisma.managedUpload.updateMany({
        where: { id: existing.id, status: { not: "complete" }, expiresAt: { lte: new Date() } },
        data: { status: "expired" },
      });
      const expired = await prisma.managedUpload.findUnique({
        where: { id: existing.id },
        include: { chunks: { select: { objectKey: true } } },
      });
      if (expired && expired.status === "expired") {
        const cleanup = await Promise.allSettled(expired.chunks.map((chunk) => deleteObject(chunk.objectKey)));
        if (cleanup.some((result) => result.status === "rejected")) {
          throw new ManagedValidationError("expired upload cleanup is still in progress; retry shortly");
        }
        await prisma.managedUpload.delete({ where: { id: expired.id } });
      }
    } else {
      return {
        ...existing,
        // Object keys are private storage coordinates, never part of the
        // client-visible resumable-upload manifest.
        chunks: existing.chunks.map(({ objectKey: _objectKey, ...chunk }) => chunk),
      };
    }
  }

  const created = await prisma.managedUpload.create({
    data: {
      workspaceId,
      meetingId: input.meetingId,
      totalChunks: input.totalChunks,
      totalBytes: input.totalBytes,
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(Date.now() + MANAGED_UPLOAD_TTL_MS),
    },
    include: { chunks: { select: { chunkIndex: true, byteLength: true, checksum: true, objectKey: true } } },
  });
  return {
    ...created,
    chunks: created.chunks.map(({ objectKey: _objectKey, ...chunk }) => chunk),
  };
}

export async function getUpload(workspaceId: string, uploadId: string) {
  const upload = await prisma.managedUpload.findFirst({ where: { id: uploadId, workspaceId }, include: { chunks: true } });
  if (!upload || !isExpired(upload)) return upload;
  await prisma.managedUpload.updateMany({
    where: { id: upload.id, status: { not: "complete" }, expiresAt: { lte: new Date() } },
    data: { status: "expired" },
  });
  return { ...upload, status: "expired" };
}

export async function completeManagedUpload(workspaceId: string, uploadId: string) {
  const upload = await getUpload(workspaceId, uploadId);
  if (!upload) throw new ManagedValidationError("upload not found");
  if (upload.status === "expired") throw new ManagedValidationError("upload session expired; start the upload again");
  if (upload.chunks.length !== upload.totalChunks) throw new ManagedValidationError("not all upload chunks have arrived");
  const totalBytes = upload.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (totalBytes !== upload.totalBytes) throw new ManagedValidationError("uploaded bytes do not match the manifest");
  return prisma.managedUpload.update({ where: { id: upload.id }, data: { status: "complete", completedAt: new Date() } });
}

/**
 * Reap abandoned upload sessions without deleting a live or completed
 * recording. The database status is claimed first so concurrent workers do
 * not both treat the same session as active; object rows are removed before
 * the upload row, and a storage failure leaves the expired row available for
 * the next cleanup pass.
 */
export async function expireManagedUploads(now = new Date()): Promise<number> {
  const candidates = await prisma.managedUpload.findMany({
    where: { status: { not: "complete" }, expiresAt: { lte: now } },
    select: { id: true },
  });
  if (candidates.length === 0) return 0;

  const ids = candidates.map((upload) => upload.id);
  await prisma.managedUpload.updateMany({
    where: { id: { in: ids }, status: { not: "complete" }, expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  const expired = await prisma.managedUpload.findMany({
    where: { id: { in: ids }, status: "expired" },
    select: { id: true, chunks: { select: { objectKey: true } } },
  });

  const removable: string[] = [];
  for (const upload of expired) {
    const results = await Promise.allSettled(upload.chunks.map((chunk) => deleteObject(chunk.objectKey)));
    if (results.every((result) => result.status === "fulfilled")) removable.push(upload.id);
    else {
      console.error("managed upload expiry cleanup failed", {
        uploadId: upload.id,
        failures: results.filter((result) => result.status === "rejected").length,
      });
    }
  }
  if (removable.length > 0) {
    await prisma.managedUpload.deleteMany({ where: { id: { in: removable }, status: "expired" } });
  }
  return removable.length;
}

/** Delete managed meeting history according to each workspace's policy. */
export async function expireManagedMeetings(now = new Date()): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { retentionDays: { not: null } },
    select: { id: true, retentionDays: true },
  });
  let removed = 0;
  for (const workspace of workspaces) {
    if (!workspace.retentionDays) continue;
    const cutoff = new Date(now.getTime() - workspace.retentionDays * 24 * 60 * 60 * 1_000);
    const meetings = await prisma.meeting.findMany({
      where: {
        workspaceId: workspace.id,
        endedAt: { lte: cutoff },
        processingJobs: { none: { status: { in: ["queued", "processing"] } } },
      },
      orderBy: { endedAt: "asc" },
      take: 100,
      select: { id: true },
    });
    for (const meeting of meetings) {
      await deleteMeeting(workspace.id, meeting.id);
      removed += 1;
    }
  }
  return removed;
}

export async function enqueueManagedJob(workspaceId: string, meetingId: string, uploadId: string, idempotencyKey: string) {
  const upload = await getUpload(workspaceId, uploadId);
  if (!upload || upload.meetingId !== meetingId || upload.status !== "complete") {
    throw new ManagedValidationError("a completed upload for this meeting is required");
  }
  const existing = await prisma.processingJob.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } });
  if (existing) {
    if (existing.status !== "error") return existing;
    await reserveMeetingProcessing(workspaceId, idempotencyKey);
    return prisma.processingJob.update({
      where: { id: existing.id },
      data: { status: "queued", errorMessage: null, startedAt: null, leaseToken: null, completedAt: null },
    });
  }
  await reserveMeetingProcessing(workspaceId, idempotencyKey);
  try {
    return await prisma.processingJob.create({
      data: { workspaceId, meetingId, uploadId, idempotencyKey, status: "queued" },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const replay = await prisma.processingJob.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } });
    if (!replay) throw error;
    return replay;
  }
}

export type ManagedRecordingChannel = "mic" | "speaker";

export async function readManagedRecording(
  workspaceId: string,
  meetingId: string,
  channel: ManagedRecordingChannel,
): Promise<{ title: string; bytes: Uint8Array } | null> {
  const upload = await prisma.managedUpload.findFirst({
    where: { workspaceId, meetingId, status: "complete" },
    orderBy: { createdAt: "desc" },
    include: { meeting: { select: { title: true } }, chunks: { where: { channel }, orderBy: { chunkIndex: "asc" } } },
  });
  if (!upload || upload.chunks.length === 0) return null;

  const parts = await Promise.all(upload.chunks.map((chunk) => getObject(chunk.objectKey)));
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { title: upload.meeting.title, bytes };
}
