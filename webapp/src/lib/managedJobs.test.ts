import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import {
  completeManagedUpload,
  createManagedUpload,
  deleteManagedUploadAudio,
  expireManagedMeetings,
  expireManagedUploads,
  getUpload,
  MANAGED_UPLOAD_TTL_MS,
  ManagedValidationError,
  readChunksSequentially,
  readManagedBytes,
  readManagedJson,
  enqueueManagedJob,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_CHUNKS,
  MAX_PENDING_MANAGED_UPLOADS,
  MAX_PENDING_MANAGED_UPLOAD_BYTES,
} from "./managedJobs";
import { getEntitlements, releaseMeetingProcessing, reserveMeetingProcessing } from "./usageLedger";
import { chunkObjectKey, getObject, putObject } from "./objectStorage";

const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();

async function createMeeting(workspaceId: string): Promise<string> {
  const id = randomUUID();
  await prisma.meeting.create({
    data: {
      id,
      userId: "managed-test-user",
      workspaceId,
      title: "Managed test meeting",
      startedAt: new Date("2026-09-24T15:00:00.000Z"),
      endedAt: new Date("2026-09-24T15:30:00.000Z"),
      summary: "",
    },
  });
  return id;
}

beforeEach(async () => {
  await prisma.workspace.createMany({
    data: [
      { id: WORKSPACE_ID, name: "Managed test workspace" },
      { id: OTHER_WORKSPACE_ID, name: "Other managed workspace" },
    ],
  });
});

afterEach(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("managed upload contracts", () => {
  it("bounds streamed request bytes and rejects invalid metadata JSON", async () => {
    await expect(readManagedBytes(new Request("http://localhost", { method: "POST", headers: { "content-length": "999" }, body: "x" }), 10))
      .rejects.toThrow("request body is too large");
    await expect(readManagedBytes(new Request("http://localhost", { method: "POST", headers: { "content-length": "1e2" }, body: "x" }), 10))
      .rejects.toThrow("request body is too large");
    const streamed = new Request("http://localhost", {
      method: "POST",
      // Node's Fetch implementation requires duplex for streaming request bodies.
      duplex: "half",
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("ab")); controller.enqueue(new TextEncoder().encode("cd")); controller.close(); },
      }),
    } as RequestInit & { duplex: "half" });
    await expect(readManagedBytes(streamed, 4)).resolves.toEqual(new TextEncoder().encode("abcd"));
    const oversized = new Request("http://localhost", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("123")); controller.enqueue(new TextEncoder().encode("456")); controller.close(); },
      }),
    } as RequestInit & { duplex: "half" });
    await expect(readManagedBytes(oversized, 5)).rejects.toThrow("request body is too large");
    await expect(readManagedJson(new Request("http://localhost", { method: "POST", body: "{" }))).rejects.toThrow("invalid JSON body");
    await expect(readManagedJson(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ok: true }) }))).resolves.toEqual({ ok: true });
    await expect(readManagedBytes(new Request("http://localhost"), 2)).resolves.toEqual(new Uint8Array());
  });

  it("validates upload manifests before storage and does not return private object keys", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const good = { meetingId, totalChunks: 1, totalBytes: 2, idempotencyKey: "valid-manifest" };
    for (const input of [
      { ...good, meetingId: "" }, { ...good, idempotencyKey: "" }, { ...good, idempotencyKey: "x".repeat(201) },
      { ...good, totalChunks: 0 }, { ...good, totalChunks: MAX_UPLOAD_CHUNKS + 1 }, { ...good, totalChunks: 1.5 },
      { ...good, totalBytes: 0 }, { ...good, totalBytes: MAX_UPLOAD_BYTES + 1 }, { ...good, totalBytes: 1.5 },
    ]) await expect(createManagedUpload(WORKSPACE_ID, input)).rejects.toThrow(ManagedValidationError);
    await expect(createManagedUpload(WORKSPACE_ID, { ...good, meetingId: randomUUID() })).rejects.toThrow("meeting not found");
    const upload = await createManagedUpload(WORKSPACE_ID, good);
    await prisma.uploadChunk.create({ data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "private-checksum", objectKey: "private/object-key" } });
    const replay = await createManagedUpload(WORKSPACE_ID, good);
    expect(replay.chunks).toEqual([{ chunkIndex: 0, byteLength: 2, checksum: "private-checksum" }]);
    expect(JSON.stringify(replay)).not.toContain("private/object-key");
  });

  it("is workspace-scoped and rejects conflicting idempotency manifests", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 2,
      totalBytes: 4,
      idempotencyKey: `upload-${meetingId}`,
    });

    const replay = await createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 2,
      totalBytes: 4,
      idempotencyKey: `upload-${meetingId}`,
    });
    expect(replay.id).toBe(upload.id);
    await expect(
      createManagedUpload(WORKSPACE_ID, {
        meetingId,
        totalChunks: 1,
        totalBytes: 4,
        idempotencyKey: `upload-${meetingId}`,
      }),
    ).rejects.toThrow("idempotency key conflicts");

    expect(await getUpload(OTHER_WORKSPACE_ID, upload.id)).toBeNull();
    await expect(completeManagedUpload(OTHER_WORKSPACE_ID, upload.id)).rejects.toThrow(ManagedValidationError);
  });

  it("reserves bounded workspace-wide pending upload count and bytes", async () => {
    const manifests = await Promise.all(Array.from({ length: MAX_PENDING_MANAGED_UPLOADS }, async (_, index) => {
      const meetingId = await createMeeting(WORKSPACE_ID);
      return createManagedUpload(WORKSPACE_ID, {
        meetingId,
        totalChunks: 1,
        totalBytes: 1,
        idempotencyKey: `pending-count-${index}-${meetingId}`,
      });
    }));
    expect(manifests).toHaveLength(MAX_PENDING_MANAGED_UPLOADS);
    const extraMeeting = await createMeeting(WORKSPACE_ID);
    await expect(createManagedUpload(WORKSPACE_ID, {
      meetingId: extraMeeting,
      totalChunks: 1,
      totalBytes: 1,
      idempotencyKey: `pending-count-extra-${extraMeeting}`,
    })).rejects.toThrow("too much temporary audio processing in progress");

    // Once staged bytes have been purged, the completed note manifest no
    // longer consumes temporary audio capacity.
    await prisma.uploadChunk.create({ data: {
      uploadId: manifests[0].id, chunkIndex: 0, channel: "mic", byteLength: 1,
      checksum: "capacity-release", objectKey: "capacity-release",
    } });
    await completeManagedUpload(WORKSPACE_ID, manifests[0].id);
    await prisma.uploadChunk.deleteMany({ where: { uploadId: manifests[0].id } });
    const afterCompleteMeeting = await createMeeting(WORKSPACE_ID);
    await expect(createManagedUpload(WORKSPACE_ID, {
      meetingId: afterCompleteMeeting,
      totalChunks: 1,
      totalBytes: 1,
      idempotencyKey: `pending-count-after-complete-${afterCompleteMeeting}`,
    })).resolves.toMatchObject({ status: "created" });

    await prisma.managedUpload.deleteMany({ where: { workspaceId: WORKSPACE_ID, status: { not: "complete" } } });
    const largeMeeting = await createMeeting(WORKSPACE_ID);
    await createManagedUpload(WORKSPACE_ID, {
      meetingId: largeMeeting,
      totalChunks: 1,
      totalBytes: 1_100_000_000,
      idempotencyKey: `pending-bytes-large-${largeMeeting}`,
    });
    const overflowMeeting = await createMeeting(WORKSPACE_ID);
    await expect(createManagedUpload(WORKSPACE_ID, {
      meetingId: overflowMeeting,
      totalChunks: 1,
      totalBytes: MAX_PENDING_MANAGED_UPLOAD_BYTES - 1_100_000_000 + 1,
      idempotencyKey: `pending-bytes-overflow-${overflowMeeting}`,
    })).rejects.toThrow("temporary audio staging limit exceeded");
  });

  it("does not oversubscribe pending workspace capacity under concurrent starts", async () => {
    const meetings = await Promise.all(Array.from({ length: MAX_PENDING_MANAGED_UPLOADS + 1 }, () => createMeeting(WORKSPACE_ID)));
    const results = await Promise.allSettled(meetings.map((meetingId, index) => createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 1,
      totalBytes: 1,
      idempotencyKey: `concurrent-cap-${index}-${meetingId}`,
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(MAX_PENDING_MANAGED_UPLOADS);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.managedUpload.count({ where: { workspaceId: WORKSPACE_ID, status: "created" } }))
      .toBe(MAX_PENDING_MANAGED_UPLOADS);
  });

  it("does not reserve completed audio as long-term workspace storage", async () => {
    const completedBytes = 1_900_000_000;
    const oldEndedAt = new Date("2026-09-20T15:30:00.000Z");
    const completedMeetingIds: string[] = [];
    await prisma.workspace.update({ where: { id: WORKSPACE_ID }, data: { retentionDays: 1 } });

    for (let index = 0; index < 2; index += 1) {
      const meetingId = await createMeeting(WORKSPACE_ID);
      completedMeetingIds.push(meetingId);
      await prisma.meeting.update({ where: { id: meetingId }, data: { endedAt: oldEndedAt } });
      const upload = await createManagedUpload(WORKSPACE_ID, {
        meetingId,
        totalChunks: 1,
        totalBytes: completedBytes,
        idempotencyKey: `retained-cap-${index}-${meetingId}`,
      });
      await prisma.uploadChunk.create({ data: {
        uploadId: upload.id,
        chunkIndex: 0,
        channel: "mic",
        byteLength: completedBytes,
        checksum: `retained-cap-${index}`,
        objectKey: `retained-cap/${WORKSPACE_ID}/${index}`,
      } });
      await completeManagedUpload(WORKSPACE_ID, upload.id);
      await prisma.uploadChunk.deleteMany({ where: { uploadId: upload.id } });
    }

    const newMeeting = await createMeeting(WORKSPACE_ID);
    await prisma.meeting.update({ where: { id: newMeeting }, data: { endedAt: new Date("2026-09-29T15:00:00.000Z") } });
    const newManifest = {
      meetingId: newMeeting,
      totalChunks: 1,
      totalBytes: 1_300_000_001,
      idempotencyKey: `retained-cap-after-cleanup-${newMeeting}`,
    };
    await expect(createManagedUpload(WORKSPACE_ID, newManifest)).resolves.toMatchObject({ status: "created" });

    // Meeting-history retention remains independent from audio staging.
    await expect(expireManagedMeetings(new Date("2026-09-29T15:30:00.000Z"))).resolves.toBeGreaterThanOrEqual(2);
    expect(await prisma.meeting.count({ where: { id: { in: completedMeetingIds } } })).toBe(0);
    expect(await prisma.managedUpload.count({ where: { meetingId: { in: completedMeetingIds } } })).toBe(0);
    await expect(createManagedUpload(WORKSPACE_ID, newManifest)).resolves.toMatchObject({ status: "created" });
  });

  it("requires every declared chunk and is safe to complete twice", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 2,
      totalBytes: 4,
      idempotencyKey: `complete-${meetingId}`,
    });

    await expect(completeManagedUpload(WORKSPACE_ID, upload.id)).rejects.toThrow("not all upload chunks");
    await prisma.uploadChunk.createMany({
      data: [
        { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "a", objectKey: "a" },
        { uploadId: upload.id, chunkIndex: 1, channel: "speaker", byteLength: 2, checksum: "b", objectKey: "b" },
      ],
    });

    const complete = await completeManagedUpload(WORKSPACE_ID, upload.id);
    expect(complete.status).toBe("complete");
    await expect(completeManagedUpload(WORKSPACE_ID, upload.id)).resolves.toMatchObject({ status: "complete" });
  });

  it("expires abandoned sessions and allows the helper to restart with the same idempotency key", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const manifest = {
      meetingId,
      totalChunks: 1,
      totalBytes: 2,
      idempotencyKey: `expired-${meetingId}`,
    };
    const upload = await createManagedUpload(WORKSPACE_ID, manifest);
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + MANAGED_UPLOAD_TTL_MS - 5_000);
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    await expect(completeManagedUpload(WORKSPACE_ID, upload.id)).rejects.toThrow("upload session expired");
    await expect(getUpload(WORKSPACE_ID, upload.id)).resolves.toMatchObject({ status: "expired" });

    const restarted = await createManagedUpload(WORKSPACE_ID, manifest);
    expect(restarted.id).not.toBe(upload.id);
    expect(restarted.status).toBe("created");
    expect(restarted.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reaps expired private chunk objects before deleting the upload row", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 1,
      totalBytes: 2,
      idempotencyKey: `cleanup-${meetingId}`,
    });
    const objectKey = chunkObjectKey(WORKSPACE_ID, upload.id, 0, "cleanup-checksum");
    await putObject(objectKey, new Uint8Array([7, 8]));
    await prisma.uploadChunk.create({
      data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "cleanup-checksum", objectKey },
    });
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    await expect(expireManagedUploads()).resolves.toBe(1);
    await expect(prisma.managedUpload.findUnique({ where: { id: upload.id } })).resolves.toBeNull();
    await expect(getObject(objectKey)).rejects.toThrow();
  });

  it("purges audio after success but preserves its workspace job manifest", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 1,
      totalBytes: 2,
      idempotencyKey: `processed-${meetingId}`,
    });
    const objectKey = chunkObjectKey(WORKSPACE_ID, upload.id, 0, "processed-audio");
    await putObject(objectKey, new Uint8Array([7, 8]));
    await prisma.uploadChunk.create({
      data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "processed-audio", objectKey },
    });
    await completeManagedUpload(WORKSPACE_ID, upload.id);
    const job = await prisma.processingJob.create({
      data: { workspaceId: WORKSPACE_ID, meetingId, uploadId: upload.id, idempotencyKey: `job-${meetingId}`, status: "complete" },
    });

    await expect(deleteManagedUploadAudio(upload.id)).resolves.toBe(true);
    await expect(getObject(objectKey)).rejects.toThrow();
    expect(await prisma.uploadChunk.count({ where: { uploadId: upload.id } })).toBe(0);
    expect(await prisma.processingJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "complete" });
    expect(await prisma.managedUpload.findUnique({ where: { id: upload.id } })).toMatchObject({ status: "complete" });
  });

  it("expires failed-job audio after 24 hours while keeping the text meeting and job record", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, {
      meetingId,
      totalChunks: 1,
      totalBytes: 2,
      idempotencyKey: `failed-expiry-${meetingId}`,
    });
    const objectKey = chunkObjectKey(WORKSPACE_ID, upload.id, 0, "failed-audio");
    await putObject(objectKey, new Uint8Array([1, 2]));
    await prisma.uploadChunk.create({
      data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "failed-audio", objectKey },
    });
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { status: "complete", expiresAt: new Date(Date.now() - 1) } });
    const job = await prisma.processingJob.create({
      data: { workspaceId: WORKSPACE_ID, meetingId, uploadId: upload.id, idempotencyKey: `failed-job-${meetingId}`, status: "error" },
    });

    await expect(expireManagedUploads()).resolves.toBe(1);
    await expect(getObject(objectKey)).rejects.toThrow();
    expect(await prisma.uploadChunk.count({ where: { uploadId: upload.id } })).toBe(0);
    expect(await prisma.managedUpload.findUnique({ where: { id: upload.id } })).toMatchObject({ status: "expired" });
    expect(await prisma.processingJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "error" });
    expect(await prisma.meeting.findUnique({ where: { id: meetingId } })).not.toBeNull();
  });

  it("retains expired uploads when object deletion fails and retries them on the next cleanup pass", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, { meetingId, totalChunks: 1, totalBytes: 1, idempotencyKey: `bad-cleanup-${meetingId}` });
    await prisma.uploadChunk.create({ data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 1, checksum: "invalid-key", objectKey: "../invalid" } });
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createManagedUpload(WORKSPACE_ID, { meetingId, totalChunks: 1, totalBytes: 1, idempotencyKey: `bad-cleanup-${meetingId}` }))
      .rejects.toThrow("expired upload cleanup is still in progress");
    await expect(expireManagedUploads()).resolves.toBe(0);
    expect(await prisma.managedUpload.findUnique({ where: { id: upload.id } })).toMatchObject({ status: "expired" });
    expect(log).toHaveBeenCalledWith("managed temporary audio cleanup failed", expect.objectContaining({ uploadId: upload.id, failures: 1 }));
    log.mockRestore();
  });

  it("handles an empty expiry pass and verifies manifest byte totals", async () => {
    await expect(expireManagedUploads()).resolves.toBe(0);
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, { meetingId, totalChunks: 1, totalBytes: 2, idempotencyKey: `byte-mismatch-${meetingId}` });
    await prisma.uploadChunk.create({ data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 1, checksum: "short", objectKey: "byte-mismatch" } });
    await expect(completeManagedUpload(WORKSPACE_ID, upload.id)).rejects.toThrow("uploaded bytes do not match the manifest");
  });

  it("recovers create races by returning the unique idempotency winner", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const manifest = { meetingId, totalChunks: 1, totalBytes: 1, idempotencyKey: `race-${meetingId}` };
    const winner = await createManagedUpload(WORKSPACE_ID, manifest);
    const find = vi.spyOn(prisma.managedUpload, "findUnique").mockResolvedValueOnce(null as never);
    const create = vi.spyOn(prisma.managedUpload, "create").mockRejectedValueOnce({ code: "P2002" });
    try {
      const replay = await createManagedUpload(WORKSPACE_ID, manifest);
      expect(replay.id).toBe(winner.id);
    } finally {
      find.mockRestore();
      create.mockRestore();
    }
  });

  it("deletes meetings and their private objects after the workspace retention window", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    await prisma.workspace.update({ where: { id: WORKSPACE_ID }, data: { retentionDays: 30 } });
    await prisma.meeting.update({ where: { id: meetingId }, data: { endedAt: new Date("2026-01-01T00:00:00.000Z") } });
    const uploadId = randomUUID();
    const objectKey = `uploads/${WORKSPACE_ID}/${uploadId}/0-retention.chunk`;
    await putObject(objectKey, new Uint8Array([9, 10]));
    await prisma.managedUpload.create({
      data: {
        id: uploadId,
        workspaceId: WORKSPACE_ID,
        meetingId,
        idempotencyKey: `retention-${meetingId}`,
        totalChunks: 1,
        totalBytes: 2,
        status: "complete",
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:00.000Z"),
        chunks: { create: { chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "retention", objectKey } },
      },
    });

    await expect(expireManagedMeetings(new Date("2026-02-15T00:00:00.000Z"))).resolves.toBe(1);
    await expect(prisma.meeting.findUnique({ where: { id: meetingId } })).resolves.toBeNull();
    await expect(getObject(objectKey)).rejects.toThrow();
  });
});

describe("managed usage reservations", () => {
  it("charges a replayed idempotency key only once", async () => {
    await prisma.workspaceSubscription.create({
      data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" },
    });

    await expect(reserveMeetingProcessing(WORKSPACE_ID, "same-job")).resolves.toEqual({ alreadyReserved: false });
    await expect(reserveMeetingProcessing(WORKSPACE_ID, "same-job")).resolves.toEqual({ alreadyReserved: true });
    expect(await prisma.usageLedgerEntry.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(1);
  });

  it("does not oversubscribe a hosted trial under concurrent reservations", async () => {
    await prisma.workspaceSubscription.create({
      data: { workspaceId: WORKSPACE_ID, plan: "hosted_trial", status: "trialing" },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => reserveMeetingProcessing(WORKSPACE_ID, `trial-${index}`)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await prisma.usageLedgerEntry.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(3);
  });

  it("releases a failed reservation and allows the same job to retry", async () => {
    await prisma.workspaceSubscription.create({
      data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" },
    });

    await expect(reserveMeetingProcessing(WORKSPACE_ID, "retry-job")).resolves.toEqual({ alreadyReserved: false });
    expect((await getEntitlements(WORKSPACE_ID)).used).toBe(1);
    await releaseMeetingProcessing(WORKSPACE_ID, "retry-job");
    await releaseMeetingProcessing(WORKSPACE_ID, "retry-job");
    expect((await getEntitlements(WORKSPACE_ID)).used).toBe(0);
    await expect(reserveMeetingProcessing(WORKSPACE_ID, "retry-job")).resolves.toEqual({ alreadyReserved: false });
    expect((await getEntitlements(WORKSPACE_ID)).used).toBe(1);
    await expect(
      prisma.usageLedgerEntry.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: WORKSPACE_ID, idempotencyKey: "retry-job" } },
      }),
    ).resolves.toMatchObject({ units: 1, releasedAt: null });
  });
});

describe("managed processing job queue", () => {
  it("requires a complete meeting upload and revives failed jobs without duplicating usage", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, { meetingId, totalChunks: 1, totalBytes: 2, idempotencyKey: `job-upload-${meetingId}` });
    await expect(enqueueManagedJob(WORKSPACE_ID, meetingId, upload.id, "job-key")).rejects.toThrow("completed upload");
    await prisma.uploadChunk.create({ data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 2, checksum: "job-checksum", objectKey: "job-chunk" } });
    await completeManagedUpload(WORKSPACE_ID, upload.id);
    await prisma.workspaceSubscription.create({ data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" } });

    const first = await enqueueManagedJob(WORKSPACE_ID, meetingId, upload.id, "job-key");
    expect(first).toMatchObject({ status: "queued", meetingId, uploadId: upload.id });
    const replay = await enqueueManagedJob(WORKSPACE_ID, meetingId, upload.id, "job-key");
    expect(replay.id).toBe(first.id);
    expect(await prisma.usageLedgerEntry.count({ where: { workspaceId: WORKSPACE_ID, idempotencyKey: "job-key" } })).toBe(1);

    await prisma.processingJob.update({ where: { id: first.id }, data: { status: "error", errorMessage: "provider failed" } });
    await releaseMeetingProcessing(WORKSPACE_ID, "job-key");
    const revived = await enqueueManagedJob(WORKSPACE_ID, meetingId, upload.id, "job-key");
    expect(revived).toMatchObject({ id: first.id, status: "queued", errorMessage: null });
  });

  it("returns the winner when two workers create the same job concurrently", async () => {
    const meetingId = await createMeeting(WORKSPACE_ID);
    const upload = await createManagedUpload(WORKSPACE_ID, { meetingId, totalChunks: 1, totalBytes: 1, idempotencyKey: `race-job-upload-${meetingId}` });
    await prisma.uploadChunk.create({ data: { uploadId: upload.id, chunkIndex: 0, channel: "mic", byteLength: 1, checksum: "race-job", objectKey: "race-job" } });
    await completeManagedUpload(WORKSPACE_ID, upload.id);
    await prisma.workspaceSubscription.create({ data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" } });
    const winner = await prisma.processingJob.create({ data: { workspaceId: WORKSPACE_ID, meetingId, uploadId: upload.id, idempotencyKey: "job-race", status: "queued" } });
    const find = vi.spyOn(prisma.processingJob, "findUnique").mockResolvedValueOnce(null as never);
    const create = vi.spyOn(prisma.processingJob, "create").mockRejectedValueOnce({ code: "P2002" });
    try {
      const replay = await enqueueManagedJob(WORKSPACE_ID, meetingId, upload.id, "job-race");
      expect(replay.id).toBe(winner.id);
    } finally {
      find.mockRestore();
      create.mockRestore();
    }
  });
});

describe("temporary audio streaming", () => {
  it("yields stored objects one at a time, in order", async () => {
    const keys = ["stream-a", "stream-b"];
    await putObject("stream-a", new Uint8Array([10, 11]));
    await putObject("stream-b", new Uint8Array([12]));
    const parts: Uint8Array[] = [];
    for await (const part of readChunksSequentially(keys)) parts.push(part);
    expect(parts.map((part) => Array.from(part))).toEqual([[10, 11], [12]]);
  });
});
