import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { deleteMeeting, upsertMeeting } from "./meetings";
import { chunkObjectKey, deleteObject, getObject, putObject } from "./objectStorage";
import { readManagedRecording } from "./managedJobs";

const WORKSPACE_ID = "77777777-0000-0000-0000-000000000007";
const MEETING_ID = "88888888-0000-0000-0000-000000000008";
const UPLOAD_ID = "99999999-0000-0000-0000-000000000009";
const OBJECT_KEY = "test-recordings/managed-mic.chunk";

beforeEach(async () => {
  await prisma.managedUpload.deleteMany({ where: { id: UPLOAD_ID } });
  await prisma.meeting.deleteMany({ where: { id: MEETING_ID } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Recording workspace" } });
  await upsertMeeting({
    id: MEETING_ID,
    title: "Recording fixture",
    startedAt: "2026-09-24T10:00:00.000Z",
    endedAt: "2026-09-24T10:05:00.000Z",
    summary: "fixture",
    transcript: [],
    actionItems: [],
  }, WORKSPACE_ID);
  await putObject(OBJECT_KEY, new Uint8Array([1, 2, 3, 4]));
  await prisma.managedUpload.create({
    data: {
      id: UPLOAD_ID,
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      idempotencyKey: "recording-fixture",
      totalChunks: 1,
      totalBytes: 4,
      status: "complete",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      chunks: { create: { chunkIndex: 0, channel: "mic", byteLength: 4, checksum: "fixture", objectKey: OBJECT_KEY } },
    },
  });
});

afterAll(async () => {
  await deleteObject(OBJECT_KEY);
  await prisma.managedUpload.deleteMany({ where: { id: UPLOAD_ID } });
  await prisma.meeting.deleteMany({ where: { id: MEETING_ID } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.$disconnect();
});

describe("managed recording object keys", () => {
  it("is deterministic for retry-safe recording chunks", () => {
    const first = chunkObjectKey("workspace", "upload", 0, "checksum");
    expect(first).toBe(chunkObjectKey("workspace", "upload", 0, "checksum"));
    expect(first).not.toBe(chunkObjectKey("workspace", "upload", 1, "checksum"));
  });

  it("reads only the requested workspace meeting channel", async () => {
    await expect(readManagedRecording(WORKSPACE_ID, MEETING_ID, "mic")).resolves.toEqual({
      title: "Recording fixture",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await expect(readManagedRecording(WORKSPACE_ID, MEETING_ID, "speaker")).resolves.toBeNull();
    await expect(readManagedRecording("aaaaaaaa-0000-0000-0000-000000000010", MEETING_ID, "mic")).resolves.toBeNull();
  });

  it("deletes the meeting rows and every managed audio object", async () => {
    await deleteMeeting(WORKSPACE_ID, MEETING_ID);

    await expect(prisma.meeting.findUnique({ where: { id: MEETING_ID } })).resolves.toBeNull();
    await expect(getObject(OBJECT_KEY)).rejects.toThrow();
  });
});
