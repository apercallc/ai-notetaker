import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
const storage = vi.hoisted(() => ({ bytes: new Uint8Array([1, 2, 3, 4]) }));
vi.mock("./objectStorage", () => ({
  directUploadsEnabled: () => true,
  signDirectUpload: async () => ({ url: "https://storage.test/signed", headers: { "If-None-Match": "*" } }),
  getObject: async () => storage.bytes,
  deleteObject: vi.fn(),
}));
import { prepareDirectUpload, completeDirectChunk } from "./directUpload";
const workspaces: string[] = [];
async function fixture() {
  const workspaceId = randomUUID(); workspaces.push(workspaceId);
  const meetingId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: "Direct fixture" } });
  await prisma.meeting.create({ data: { id: meetingId, workspaceId, userId: "fixture", title: "fixture", summary: "", startedAt: new Date(), endedAt: new Date() } });
  const upload = await prisma.managedUpload.create({ data: { workspaceId, meetingId, idempotencyKey: randomUUID(), totalChunks: 2, totalBytes: 4, expiresAt: new Date(Date.now() + 60_000) } });
  return { workspaceId, uploadId: upload.id };
}
afterEach(async () => {
  await prisma.meeting.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  workspaces.length = 0; storage.bytes = new Uint8Array([1, 2, 3, 4]);
});
const metadata = () => ({ byteLength: 4, checksum: createHash("sha256").update(storage.bytes).digest("hex"), channel: "mic" });
describe("direct upload admission and verification", () => {
  it("validates metadata/index boundaries and reuses a reserved or completed chunk", async () => {
    const f = await fixture();
    await expect(prepareDirectUpload(f.workspaceId, f.uploadId, "-1", metadata())).rejects.toThrow("index");
    await expect(prepareDirectUpload(f.workspaceId, f.uploadId, "0", { ...metadata(), byteLength: 0 })).rejects.toThrow("metadata");
    await expect(prepareDirectUpload(f.workspaceId, f.uploadId, "2", metadata())).rejects.toThrow("outside");
    await expect(completeDirectChunk(f.workspaceId, f.uploadId, "0")).rejects.toThrow("reservation");
    await prepareDirectUpload(f.workspaceId, f.uploadId, "0", metadata());
    const ticket = await prisma.directUploadTicket.findFirstOrThrow({ where: { uploadId: f.uploadId } });
    await prepareDirectUpload(f.workspaceId, f.uploadId, "0", metadata());
    expect(await prisma.directUploadTicket.count({ where: { uploadId: f.uploadId } })).toBe(1);
    expect((await prisma.directUploadTicket.findFirstOrThrow({ where: { uploadId: f.uploadId } })).objectKey).toBe(ticket.objectKey);
    await completeDirectChunk(f.workspaceId, f.uploadId, "0");
    await expect(prepareDirectUpload(f.workspaceId, f.uploadId, "0", metadata())).resolves.toEqual({ replayed: true });
  });
  it("rejects other workspaces and binds retry metadata", async () => {
    const f = await fixture();
    await expect(prepareDirectUpload(randomUUID(), f.uploadId, "0", metadata())).rejects.toThrow("unavailable");
    await prepareDirectUpload(f.workspaceId, f.uploadId, "0", metadata());
    await expect(prepareDirectUpload(f.workspaceId, f.uploadId, "0", { ...metadata(), channel: "speaker" })).rejects.toThrow("conflicts");
    await expect(completeDirectChunk(randomUUID(), f.uploadId, "0")).rejects.toThrow("unavailable");
  });
  it("reserves declared capacity across parallel sign requests", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled(["0", "1"].map((index) => prepareDirectUpload(f.workspaceId, f.uploadId, index, metadata())));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.directUploadTicket.count({ where: { uploadId: f.uploadId } })).toBe(1);
  });
  it("checks stored bytes then accepts idempotent completion", async () => {
    const f = await fixture();
    await prepareDirectUpload(f.workspaceId, f.uploadId, "0", metadata());
    storage.bytes = new Uint8Array([4, 3, 2, 1]);
    await expect(completeDirectChunk(f.workspaceId, f.uploadId, "0")).rejects.toThrow("checksum");
    storage.bytes = new Uint8Array([1, 2, 3, 4]);
    await completeDirectChunk(f.workspaceId, f.uploadId, "0");
    expect((await prisma.uploadChunk.findUniqueOrThrow({ where: { uploadId_chunkIndex: { uploadId: f.uploadId, chunkIndex: 0 } } })).signedUntil).not.toBeNull();
    await expect(completeDirectChunk(f.workspaceId, f.uploadId, "0")).resolves.toEqual({ replayed: true });
    expect(await prisma.directUploadTicket.count({ where: { uploadId: f.uploadId } })).toBe(0);
    await prisma.managedUpload.update({ where: { id: f.uploadId }, data: { expiresAt: new Date(0) } });
    await expect(completeDirectChunk(f.workspaceId, f.uploadId, "0")).rejects.toThrow("expired");
  });
});
