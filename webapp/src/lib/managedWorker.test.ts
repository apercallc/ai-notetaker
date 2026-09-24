import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { enqueueManagedJob } from "./managedJobs";
import { prisma } from "./db";
import { getEntitlements } from "./usageLedger";
import { putObject } from "./objectStorage";
import { MANAGED_JOB_LEASE_MS, ManagedWorkerError, nextManagedJob, parseDeepgramTranscript, parseSummary, providerRequest, runManagedJob } from "./managedWorker";

describe("managed provider requests", () => {
  it("retries transient provider responses and returns the later success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(providerRequest("https://provider.example.test", { method: "POST" }, "transcription")).resolves.toMatchObject({ status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it("fails permanent provider errors without retrying", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(providerRequest("https://provider.example.test", { method: "POST" }, "summary")).rejects.toThrow("summary provider returned 400");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe("managed worker response parsing", () => {
  it("normalizes a Deepgram transcript to a channel speaker", () => {
    expect(parseDeepgramTranscript({ results: { channels: [{ alternatives: [{ transcript: "  hello there  " }] }] } }, "you")).toEqual({ speaker: "you", text: "hello there" });
    expect(parseDeepgramTranscript({ results: { channels: [] } }, "them")).toBeNull();
  });

  it("bounds and validates summary action items", () => {
    expect(parseSummary({ summary: "done", actionItems: [{ text: "follow up", owner: "Sam" }, { text: 4 }] })).toEqual({ summary: "done", actionItems: [{ text: "follow up", owner: "Sam" }] });
    expect(() => parseSummary({ actionItems: [] })).toThrow(ManagedWorkerError);
  });
});

describe("managed worker lifecycle", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("releases the processing unit when a provider attempt fails and requeues safely", async () => {
    const workspaceId = randomUUID();
    const meetingId = randomUUID();
    const uploadId = randomUUID();
    const storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-managed-worker-"));
    const previousStorageDir = process.env.OBJECT_STORAGE_DIR;
    const previousDeepgramKey = process.env.MANAGED_DEEPGRAM_API_KEY;
    const previousAnthropicKey = process.env.MANAGED_ANTHROPIC_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider unavailable", { status: 503 }));
    process.env.OBJECT_STORAGE_DIR = storageDir;
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    process.env.MANAGED_ANTHROPIC_API_KEY = "test-anthropic-key";

    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Worker test workspace" } });
      await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
      await prisma.meeting.create({
        data: {
          id: meetingId,
          userId: "managed-worker-test-user",
          workspaceId,
          title: "Worker retry meeting",
          startedAt: new Date("2026-09-24T15:00:00.000Z"),
          endedAt: new Date("2026-09-24T15:30:00.000Z"),
          summary: "",
        },
      });
      await prisma.managedUpload.create({
        data: {
          id: uploadId,
          workspaceId,
          meetingId,
          idempotencyKey: `upload-${uploadId}`,
          totalChunks: 1,
          totalBytes: 1,
          status: "complete",
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
          completedAt: new Date(),
        },
      });
      const objectKey = `uploads/${workspaceId}/${uploadId}/0-worker.chunk`;
      await putObject(objectKey, new Uint8Array([1]));
      await prisma.uploadChunk.create({
        data: { uploadId, chunkIndex: 0, channel: "mic", byteLength: 1, checksum: "worker", objectKey },
      });

      const idempotencyKey = `job-${meetingId}`;
      const job = await enqueueManagedJob(workspaceId, meetingId, uploadId, idempotencyKey);
      expect((await getEntitlements(workspaceId)).used).toBe(1);
      await expect(runManagedJob(workspaceId, job.id)).rejects.toThrow("transcription provider returned 503");
      expect(await prisma.processingJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "error" });
      expect((await getEntitlements(workspaceId)).used).toBe(0);

      const retry = await enqueueManagedJob(workspaceId, meetingId, uploadId, idempotencyKey);
      expect(retry).toMatchObject({ id: job.id, status: "queued" });
      expect((await getEntitlements(workspaceId)).used).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await rm(storageDir, { recursive: true, force: true });
      if (previousStorageDir === undefined) delete process.env.OBJECT_STORAGE_DIR;
      else process.env.OBJECT_STORAGE_DIR = previousStorageDir;
      if (previousDeepgramKey === undefined) delete process.env.MANAGED_DEEPGRAM_API_KEY;
      else process.env.MANAGED_DEEPGRAM_API_KEY = previousDeepgramKey;
      if (previousAnthropicKey === undefined) delete process.env.MANAGED_ANTHROPIC_API_KEY;
      else process.env.MANAGED_ANTHROPIC_API_KEY = previousAnthropicKey;
      fetchSpy.mockRestore();
    }
  });

  it("processes both audio channels and persists the hosted summary", async () => {
    const workspaceId = randomUUID();
    const meetingId = randomUUID();
    const uploadId = randomUUID();
    const storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-managed-worker-success-"));
    const previousStorageDir = process.env.OBJECT_STORAGE_DIR;
    const previousDeepgramKey = process.env.MANAGED_DEEPGRAM_API_KEY;
    const previousAnthropicKey = process.env.MANAGED_ANTHROPIC_API_KEY;
    let deepgramCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.deepgram.com")) {
        deepgramCalls += 1;
        const transcript = deepgramCalls === 1 ? "I will send the draft" : "Please send it by Friday";
        return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), { status: 200 });
      }
      if (url.includes("api.anthropic.com")) {
        return new Response(JSON.stringify({ content: [{ text: JSON.stringify({ summary: "The draft is due Friday.", actionItems: [{ text: "Send the draft", owner: "You" }] }) }] }), { status: 200 });
      }
      return new Response("unexpected provider", { status: 500 });
    });
    process.env.OBJECT_STORAGE_DIR = storageDir;
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    process.env.MANAGED_ANTHROPIC_API_KEY = "test-anthropic-key";

    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Successful worker workspace" } });
      await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
      await prisma.meeting.create({
        data: {
          id: meetingId,
          userId: "managed-worker-success-user",
          workspaceId,
          title: "Successful hosted meeting",
          startedAt: new Date("2026-09-24T15:00:00.000Z"),
          endedAt: new Date("2026-09-24T15:30:00.000Z"),
          summary: "",
        },
      });
      await prisma.managedUpload.create({
        data: {
          id: uploadId,
          workspaceId,
          meetingId,
          idempotencyKey: `upload-${uploadId}`,
          totalChunks: 2,
          totalBytes: 2,
          status: "complete",
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
          completedAt: new Date(),
        },
      });
      const micKey = `uploads/${workspaceId}/${uploadId}/0-success-mic.chunk`;
      const speakerKey = `uploads/${workspaceId}/${uploadId}/1-success-speaker.chunk`;
      await putObject(micKey, new Uint8Array([1]));
      await putObject(speakerKey, new Uint8Array([2]));
      await prisma.uploadChunk.createMany({
        data: [
          { uploadId, chunkIndex: 0, channel: "mic", byteLength: 1, checksum: "success-mic", objectKey: micKey },
          { uploadId, chunkIndex: 1, channel: "speaker", byteLength: 1, checksum: "success-speaker", objectKey: speakerKey },
        ],
      });

      const job = await enqueueManagedJob(workspaceId, meetingId, uploadId, `job-${meetingId}`);
      await prisma.processingJob.update({
        where: { id: job.id },
        data: { status: "processing", startedAt: new Date(Date.now() - MANAGED_JOB_LEASE_MS - 1_000), leaseToken: "crashed-worker" },
      });
      expect(await nextManagedJob()).toMatchObject({ jobId: job.id, workspaceId });
      await expect(runManagedJob(workspaceId, job.id)).resolves.toBeUndefined();

      expect(await prisma.processingJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "complete" });
      expect(await prisma.meeting.findUnique({ where: { id: meetingId }, include: { transcript: { orderBy: { order: "asc" } }, actionItems: true } })).toMatchObject({
        summary: "The draft is due Friday.",
        processingMode: "managed",
        transcript: [
          { speaker: "you", text: "I will send the draft", userId: "managed-worker-success-user" },
          { speaker: "them", text: "Please send it by Friday", userId: "managed-worker-success-user" },
        ],
        actionItems: [{ text: "Send the draft", owner: "You", userId: "managed-worker-success-user" }],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect((await getEntitlements(workspaceId)).used).toBe(1);
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await rm(storageDir, { recursive: true, force: true });
      if (previousStorageDir === undefined) delete process.env.OBJECT_STORAGE_DIR;
      else process.env.OBJECT_STORAGE_DIR = previousStorageDir;
      if (previousDeepgramKey === undefined) delete process.env.MANAGED_DEEPGRAM_API_KEY;
      else process.env.MANAGED_DEEPGRAM_API_KEY = previousDeepgramKey;
      if (previousAnthropicKey === undefined) delete process.env.MANAGED_ANTHROPIC_API_KEY;
      else process.env.MANAGED_ANTHROPIC_API_KEY = previousAnthropicKey;
      fetchSpy.mockRestore();
    }
  });

  it("allows only one concurrent worker to claim a queued job", async () => {
    const workspaceId = randomUUID();
    const meetingId = randomUUID();
    const uploadId = randomUUID();
    const storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-managed-worker-claim-"));
    const previousStorageDir = process.env.OBJECT_STORAGE_DIR;
    const previousDeepgramKey = process.env.MANAGED_DEEPGRAM_API_KEY;
    const previousAnthropicKey = process.env.MANAGED_ANTHROPIC_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider unavailable", { status: 503 }));
    process.env.OBJECT_STORAGE_DIR = storageDir;
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    process.env.MANAGED_ANTHROPIC_API_KEY = "test-anthropic-key";

    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Concurrent worker workspace" } });
      await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
      await prisma.meeting.create({
        data: {
          id: meetingId,
          userId: "managed-worker-claim-user",
          workspaceId,
          title: "Concurrent worker meeting",
          startedAt: new Date("2026-09-24T15:00:00.000Z"),
          endedAt: new Date("2026-09-24T15:30:00.000Z"),
          summary: "",
        },
      });
      await prisma.managedUpload.create({
        data: {
          id: uploadId,
          workspaceId,
          meetingId,
          idempotencyKey: `upload-${uploadId}`,
          totalChunks: 1,
          totalBytes: 1,
          status: "complete",
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
          completedAt: new Date(),
        },
      });
      const objectKey = `uploads/${workspaceId}/${uploadId}/0-worker-claim.chunk`;
      await putObject(objectKey, new Uint8Array([1]));
      await prisma.uploadChunk.create({
        data: { uploadId, chunkIndex: 0, channel: "mic", byteLength: 1, checksum: "worker-claim", objectKey },
      });
      const job = await enqueueManagedJob(workspaceId, meetingId, uploadId, `job-${meetingId}`);

      const results = await Promise.allSettled([runManagedJob(workspaceId, job.id), runManagedJob(workspaceId, job.id)]);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
      expect(results.some((result) => result.status === "rejected" && result.reason instanceof ManagedWorkerError && result.reason.message === "job not found or already running")).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(await prisma.processingJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "error" });
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await rm(storageDir, { recursive: true, force: true });
      if (previousStorageDir === undefined) delete process.env.OBJECT_STORAGE_DIR;
      else process.env.OBJECT_STORAGE_DIR = previousStorageDir;
      if (previousDeepgramKey === undefined) delete process.env.MANAGED_DEEPGRAM_API_KEY;
      else process.env.MANAGED_DEEPGRAM_API_KEY = previousDeepgramKey;
      if (previousAnthropicKey === undefined) delete process.env.MANAGED_ANTHROPIC_API_KEY;
      else process.env.MANAGED_ANTHROPIC_API_KEY = previousAnthropicKey;
      fetchSpy.mockRestore();
    }
  });
});
