import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import {
  completeManagedUpload,
  createManagedUpload,
  expireManagedMeetings,
  expireManagedUploads,
  getUpload,
  MANAGED_UPLOAD_TTL_MS,
  ManagedValidationError,
  chunksToReadableStream,
  openManagedRecording,
  readChunksSequentially,
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

describe("streaming recording reads", () => {
  async function createStreamedRecording(workspaceId: string): Promise<string> {
    const meetingId = await createMeeting(workspaceId);
    const uploadId = randomUUID();
    const keys = [0, 1].map((index) => `uploads/${workspaceId}/${uploadId}/${index}-stream.chunk`);
    await putObject(keys[0], new Uint8Array([1, 2, 3, 4]));
    await putObject(keys[1], new Uint8Array([5, 6]));
    await prisma.managedUpload.create({
      data: {
        id: uploadId,
        workspaceId,
        meetingId,
        idempotencyKey: `stream-${meetingId}`,
        totalChunks: 3,
        totalBytes: 8,
        status: "complete",
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        completedAt: new Date(),
        chunks: {
          create: [
            { chunkIndex: 0, channel: "mic", byteLength: 4, checksum: "stream-0", objectKey: keys[0] },
            { chunkIndex: 1, channel: "mic", byteLength: 2, checksum: "stream-1", objectKey: keys[1] },
            { chunkIndex: 2, channel: "speaker", byteLength: 2, checksum: "stream-2", objectKey: `${uploadId}-speaker` },
          ],
        },
      },
    });
    return meetingId;
  }

  it("yields stored objects one at a time, in order", async () => {
    const keys = ["stream-a", "stream-b"];
    await putObject("stream-a", new Uint8Array([10, 11]));
    await putObject("stream-b", new Uint8Array([12]));
    const parts: Uint8Array[] = [];
    for await (const part of readChunksSequentially(keys)) parts.push(part);
    expect(parts.map((part) => Array.from(part))).toEqual([[10, 11], [12]]);
  });

  it("streams a recording chunk by chunk without loading it into memory", async () => {
    const meetingId = await createStreamedRecording(WORKSPACE_ID);
    const recording = await openManagedRecording(WORKSPACE_ID, meetingId, "mic");
    expect(recording).toMatchObject({ title: "Managed test meeting", totalBytes: 6 });

    const parts: Uint8Array[] = [];
    for await (const part of recording!.chunks) parts.push(part);
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6]);

    // Another workspace can never open this recording.
    await expect(openManagedRecording(OTHER_WORKSPACE_ID, meetingId, "mic")).resolves.toBeNull();
    // No completed upload for the meeting at all.
    await expect(openManagedRecording(WORKSPACE_ID, randomUUID(), "mic")).resolves.toBeNull();
  });

  it("wraps the chunks as a ReadableStream response body and supports cancellation", async () => {
    const meetingId = await createStreamedRecording(WORKSPACE_ID);
    const response = new Response((await openManagedRecording(WORKSPACE_ID, meetingId, "mic"))!.stream());
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6]);

    const stream = chunksToReadableStream(readChunksSequentially(["stream-a", "stream-b"]));
    const reader = stream.getReader();
    expect(Array.from((await reader.read()).value!)).toEqual([10, 11]);
    await reader.cancel();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });
});
