import { prisma } from "./db";
import { getEntitlements, releaseMeetingProcessing, reserveMeetingProcessing } from "./usageLedger";
import { audioSecondsForBytes } from "./plans";
import { AudioBudgetError, EntitlementError } from "./entitlementError";
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
/** Bound audio staging reservations across every member of a workspace. */
export const MAX_PENDING_MANAGED_UPLOADS = 5;
/** Bytes reserved by temporary managed uploads in one workspace (about 1.86 GiB). */
export const MAX_PENDING_MANAGED_UPLOAD_BYTES = 2_000_000_000;

export class ManagedUploadQuotaError extends ManagedValidationError {
  constructor(message: string) {
    super(message);
    this.name = "ManagedUploadQuotaError";
  }
}

function isExpired(upload: { status: string; expiresAt: Date }, now = Date.now()): boolean {
  return upload.status === "expired" || upload.expiresAt.getTime() <= now;
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
        where: { id: existing.id, status: { not: "expired" }, expiresAt: { lte: new Date() } },
        data: { status: "expired" },
      });
      const expired = await prisma.managedUpload.findUnique({
        where: { id: existing.id },
        include: { chunks: { select: { objectKey: true } } },
      });
      if (expired && expired.status === "expired") {
        if (!(await deleteManagedUploadAudio(expired.id))) {
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

  // Fail before any audio is staged: an exhausted plan would otherwise fill
  // the staging cap for 24 hours and only be refused after the upload.
  const entitlements = await getEntitlements(workspaceId);
  if (!entitlements.canProcess) throw new EntitlementError();
  if (audioSecondsForBytes(input.totalBytes) > entitlements.audio.remainingSeconds) throw new AudioBudgetError();

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      // Lock the existing workspace row while checking and reserving capacity.
      // This serializes distinct manifest creations across app replicas without
      // adding a quota table or relying on a racy count-then-insert sequence.
      const workspaces = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE
      `;
      if (workspaces.length !== 1) throw new ManagedValidationError("workspace not found");

      // Another request with this key may have won while this request waited
      // for the workspace lock. Preserve idempotency and avoid double reserve.
      const concurrent = await tx.managedUpload.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: input.idempotencyKey } },
        include: { chunks: { select: { chunkIndex: true, byteLength: true, checksum: true, objectKey: true } } },
      });
      if (concurrent) {
        if (
          concurrent.meetingId !== input.meetingId ||
          concurrent.totalChunks !== input.totalChunks ||
          concurrent.totalBytes !== input.totalBytes
        ) throw new ManagedValidationError("idempotency key conflicts with an existing upload");
        if (isExpired(concurrent)) throw new ManagedValidationError("expired upload cleanup is still in progress; retry shortly");
        return concurrent;
      }

      // Count every manifest that can still have staged bytes, including a
      // completed job whose storage deletion failed. Cleanup errors therefore
      // fail closed instead of allowing staged audio to accumulate unmetered.
      const pending = await tx.managedUpload.aggregate({
        where: {
          workspaceId,
          OR: [
            { status: { in: ["created", "uploading", "expired"] } },
            { chunks: { some: {} } },
          ],
        },
        _count: { _all: true },
        _sum: { totalBytes: true },
      });
      const pendingCount = pending._count._all;
      const pendingBytes = pending._sum.totalBytes ?? 0;
      if (pendingCount >= MAX_PENDING_MANAGED_UPLOADS) {
        throw new ManagedUploadQuotaError("workspace has too much temporary audio processing in progress; wait for a job or cleanup to finish before starting another");
      }
      if (pendingBytes + input.totalBytes > MAX_PENDING_MANAGED_UPLOAD_BYTES) {
        throw new ManagedUploadQuotaError("workspace temporary audio staging limit exceeded; wait for a job or cleanup to finish before starting another");
      }
      return tx.managedUpload.create({
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
    });
  } catch (error) {
    // Two concurrent createManagedUpload calls with the same idempotency key
    // (both past the expired-cleanup branch) race this insert. The loser
    // sees the winner's row: return it as the idempotent result instead of
    // surfacing a 500 the client can only blindly retry.
    if ((error as { code?: string }).code !== "P2002") throw error;
    const winner = await prisma.managedUpload.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: input.idempotencyKey } },
      include: { chunks: { select: { chunkIndex: true, byteLength: true, checksum: true, objectKey: true } } },
    });
    if (!winner) throw error;
    if (winner.meetingId !== input.meetingId || winner.totalChunks !== input.totalChunks || winner.totalBytes !== input.totalBytes) {
      throw new ManagedValidationError("idempotency key conflicts with an existing upload");
    }
    created = winner;
  }
  return {
    ...created,
    chunks: created.chunks.map(({ objectKey: _objectKey, ...chunk }) => chunk),
  };
}

export async function getUpload(workspaceId: string, uploadId: string) {
  const upload = await prisma.managedUpload.findFirst({ where: { id: uploadId, workspaceId }, include: { chunks: true } });
  if (!upload || !isExpired(upload)) return upload;
  await prisma.managedUpload.updateMany({
      where: { id: upload.id, status: { not: "expired" }, expiresAt: { lte: new Date() } },
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
 * Removes staged recording bytes while keeping the upload/job manifest needed
 * for status and billing history. Object rows are removed only after every
 * corresponding object has been deleted; a storage error therefore leaves a
 * retryable cleanup record for the next worker heartbeat.
 */
export async function deleteManagedUploadAudio(uploadId: string): Promise<boolean> {
  const chunks = await prisma.uploadChunk.findMany({ where: { uploadId }, select: { id: true, objectKey: true } });
  if (chunks.length === 0) return true;
  // Large recordings can have 10,000 objects; cap simultaneous requests so
  // cleanup does not exhaust sockets or starve provider uploads in the worker.
  const failures: PromiseRejectedResult[] = [];
  for (let offset = 0; offset < chunks.length; offset += 16) {
    const results = await Promise.allSettled(chunks.slice(offset, offset + 16).map((chunk) => deleteObject(chunk.objectKey)));
    failures.push(...results.filter((result): result is PromiseRejectedResult => result.status === "rejected"));
  }
  if (failures.length > 0) {
    console.error("managed temporary audio cleanup failed", {
      uploadId,
      failures: failures.length,
      firstError: failures[0]?.reason instanceof Error ? failures[0].reason.message : String(failures[0]?.reason),
    });
    return false;
  }
  await prisma.uploadChunk.deleteMany({ where: { uploadId, id: { in: chunks.map((chunk) => chunk.id) } } });
  return true;
}

/**
 * Managed audio is staging data, never meeting history. Successful jobs are
 * purged immediately. Abandoned/failed uploads remain available for retry
 * only until their fixed 24-hour expiry; stale jobs are failed before cleanup.
 */
let uploadSweepAfter: { expiresAt: Date; id: string } | undefined;
let legacySweepAfter: string | undefined;

export async function expireManagedUploads(now = new Date()): Promise<number> {
  const uploads = await prisma.managedUpload.findMany({
    where: {
      ...(uploadSweepAfter ? { AND: [{ OR: [
        { expiresAt: { gt: uploadSweepAfter.expiresAt } },
        { expiresAt: uploadSweepAfter.expiresAt, id: { gt: uploadSweepAfter.id } },
      ] }] } : {}),
      OR: [
        { jobs: { some: { status: "complete" } }, chunks: { some: {} } },
        { expiresAt: { lte: now }, status: { not: "expired" } },
        { expiresAt: { lte: now }, status: "expired", chunks: { some: {} } },
      ],
    },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      expiresAt: true,
      jobs: { select: { id: true, status: true, startedAt: true, idempotencyKey: true } },
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  // Progress even when individual deletions fail; otherwise 100 poison
  // records at the front would permanently hide all later private audio.
  const lastUpload = uploads.at(-1);
  uploadSweepAfter = uploads.length === 100 && lastUpload ? { expiresAt: lastUpload.expiresAt, id: lastUpload.id } : undefined;
  let cleaned = 0;
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1_000);
  for (const upload of uploads) {
    const successful = upload.jobs.some((job) => job.status === "complete");
    const activeJobs = upload.jobs.filter((job) =>
      job.status === "queued" || (job.status === "processing" && (!job.startedAt || job.startedAt > staleBefore)),
    );
    if (!successful && upload.expiresAt > now && activeJobs.length > 0) continue;

    if (!successful && upload.expiresAt <= now) {
      const staleJobs = upload.jobs.filter((job) => job.status === "queued" || job.status === "processing");
      for (const job of staleJobs) {
        const failed = await prisma.processingJob.updateMany({
          where: { id: job.id, status: { in: ["queued", "processing"] } },
          data: {
            status: "error",
            errorMessage: "Temporary audio expired after 24 hours. Retry from the app while the local recording is still available.",
            completedAt: now,
            leaseToken: null,
          },
        });
        if (failed.count > 0) {
          await releaseMeetingProcessing(upload.workspaceId, job.idempotencyKey).catch((error: unknown) => {
            console.error("managed expired upload usage release failed", {
              uploadId: upload.id,
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    }

    if (!(await deleteManagedUploadAudio(upload.id))) continue;
    if (successful) {
      cleaned += 1;
      continue;
    }
    await prisma.managedUpload.updateMany({ where: { id: upload.id, status: { not: "expired" } }, data: { status: "expired" } });
    if (upload.jobs.length === 0) {
      await prisma.managedUpload.deleteMany({ where: { id: upload.id, status: "expired" } });
    }
    cleaned += 1;
  }

  // Remove audio written by the earlier durable-recording implementation as
  // part of the same managed-worker sweep. The field remains in Prisma only
  // so existing rows can be cleaned safely during rollout.
  const legacyRecordings = await prisma.meeting.findMany({
    where: { processingMode: "managed", recordingObjectKey: { not: null }, ...(legacySweepAfter ? { id: { gt: legacySweepAfter } } : {}) },
    select: { id: true, recordingObjectKey: true },
    orderBy: { id: "asc" },
    take: 100,
  });
  legacySweepAfter = legacyRecordings.length === 100 ? legacyRecordings.at(-1)?.id : undefined;
  for (const meeting of legacyRecordings) {
    if (!meeting.recordingObjectKey) continue;
    try {
      await deleteObject(meeting.recordingObjectKey);
      await prisma.meeting.updateMany({
        where: { id: meeting.id, recordingObjectKey: meeting.recordingObjectKey },
        data: { recordingObjectKey: null },
      });
      cleaned += 1;
    } catch (error) {
      console.error("legacy managed recording cleanup failed", {
        meetingId: meeting.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return cleaned;
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
  // One job per upload: a second request with a different idempotency key must
  // not reserve another unit or reprocess audio that is purged after success
  // (which would finalize an empty transcript over the real one).
  const existing =
    (await prisma.processingJob.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } })) ??
    (await prisma.processingJob.findFirst({ where: { workspaceId, uploadId }, orderBy: { createdAt: "asc" } }));
  if (existing) {
    if (existing.meetingId !== meetingId) throw new ManagedValidationError("idempotency key conflicts with an existing meeting job");
    if (existing.status !== "error") return existing;
    if (existing.uploadId !== uploadId) {
      const original = await prisma.managedUpload.findUnique({ where: { id: existing.uploadId }, select: { totalBytes: true } });
      // Layout migrations regroup the same recording; they cannot change its
      // billable bytes. A live reservation may already hold the old duration.
      if (!original || original.totalBytes !== upload.totalBytes) {
        throw new ManagedValidationError("replacement upload must contain the same recording bytes");
      }
    }
    await reserveMeetingProcessing(workspaceId, existing.idempotencyKey, upload.totalBytes);
    // Guard on status so two concurrent retries cannot reset a job another
    // request already restarted and a worker has begun.
    try {
      await prisma.processingJob.updateMany({
        where: { id: existing.id, status: "error" },
        // Packing versions can supply a new upload for this same meeting.
        // Claim the replacement atomically with the retry status; never run
        // the failed job against its old expired or purged audio manifest.
        data: { uploadId, status: "queued", errorMessage: null, startedAt: null, leaseToken: null, completedAt: null, attempts: 0 },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const winner = await prisma.processingJob.findUnique({ where: { uploadId } });
      if (!winner || winner.meetingId !== meetingId || winner.workspaceId !== workspaceId) throw error;
      if (winner.idempotencyKey !== existing.idempotencyKey) await releaseMeetingProcessing(workspaceId, existing.idempotencyKey);
      return winner;
    }
    // count 0 means another retry won; the shared idempotency key already
    // holds the single reservation, so there is nothing to undo here.
    return prisma.processingJob.findUniqueOrThrow({ where: { id: existing.id } });
  }
  await reserveMeetingProcessing(workspaceId, idempotencyKey, upload.totalBytes);
  try {
    return await prisma.processingJob.create({
      data: { workspaceId, meetingId, uploadId, idempotencyKey, status: "queued" },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    // Lost a race: the unique keys are (workspace, idempotency key) and
    // (upload). Return the winner, and give back the unit this loser reserved
    // if the winner used a different key.
    const replay =
      (await prisma.processingJob.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } })) ??
      (await prisma.processingJob.findUnique({ where: { uploadId } }));
    if (!replay) throw error;
    if (replay.meetingId !== meetingId) throw new ManagedValidationError("idempotency key conflicts with an existing meeting job");
    if (replay.idempotencyKey !== idempotencyKey) await releaseMeetingProcessing(workspaceId, idempotencyKey);
    return replay;
  }
}

/**
 * Yields the given stored objects one at a time, in order. At most one chunk
 * (MAX_CHUNK_BYTES) is held in memory, so staged audio can be forwarded to a
 * provider without materializing the full recording.
 */
export async function* readChunksSequentially(objectKeys: Iterable<string>): AsyncGenerator<Uint8Array, void, undefined> {
  for (const key of objectKeys) {
    yield await getObject(key);
  }
}

/** Wraps an async chunk iterator as a web ReadableStream (pull-based, so it honours back-pressure). */
export function chunksToReadableStream(chunks: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}
