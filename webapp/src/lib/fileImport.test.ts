import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { AudioBudgetError } from "./entitlementError";
import { createManagedUpload, enqueueManagedJob, expireManagedUploads, ManagedValidationError, MAX_UPLOAD_BYTES } from "./managedJobs";
import { relabelImportedSpeakers, runManagedJob } from "./managedWorker";
import { getObject, putObject } from "./objectStorage";
import { estimateImportSeconds, PLAN_AUDIO_HOUR_LIMITS, PLAN_IMPORT_MAX_SECONDS } from "./plans";
import { speakerLabel } from "./types";
import { adjustReservedAudioSeconds, getEntitlements, releaseMeetingProcessing, reserveMeetingProcessing } from "./usageLedger";

const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe("estimateImportSeconds", () => {
  it("bills imports at declared duration, not the two-channel byte formula", () => {
    expect(estimateImportSeconds(1_000_000, 600)).toBe(600);
  });

  it("never reserves less than the size-based floor, so a tiny claim for a huge file still counts", () => {
    expect(estimateImportSeconds(1_800_000_000, 5)).toBe(900);
  });

  it("falls back to a 128 kbit/s assumption when the browser cannot read a duration", () => {
    expect(estimateImportSeconds(16_000 * 100)).toBe(100);
    expect(estimateImportSeconds(16_000 * 100, Number.NaN)).toBe(100);
    expect(estimateImportSeconds(16_000 * 100, -4)).toBe(100);
  });

  it("rounds a fractional declared duration up", () => {
    expect(estimateImportSeconds(10_000, 2.2)).toBe(3);
  });
});

describe("imported speaker labels", () => {
  it("renders speaker ids as Speaker N without disturbing live-capture labels", () => {
    expect(speakerLabel("speaker")).toBe("Speaker");
    expect(speakerLabel("speaker-2")).toBe("Speaker 2");
    expect(speakerLabel("you")).toBe("You");
    expect(speakerLabel("them-3")).toBe("Them 3");
    expect(speakerLabel("them")).toBe("Them");
  });

  it("relabels provider output for a single mixed track", () => {
    const utterances = [
      { speaker: "them-1", text: "a", startMs: 0, endMs: 1 },
      { speaker: "them-2", text: "b", startMs: 1, endMs: 2 },
      { speaker: "them", text: "c", startMs: 2, endMs: 3 },
      { speaker: "you", text: "d", startMs: 3, endMs: 4 },
    ];
    expect(relabelImportedSpeakers(utterances).map((utterance) => utterance.speaker)).toEqual(["speaker-1", "speaker-2", "speaker", "you"]);
  });
});

describe("import usage metering", () => {
  const workspaceId = randomUUID();

  beforeEach(async () => {
    await prisma.workspace.create({ data: { id: workspaceId, name: "Import ledger workspace" } });
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
  });

  afterEach(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reserves exact audio seconds instead of the byte-derived figure", async () => {
    await reserveMeetingProcessing(workspaceId, "import:a", 1_000_000, { audioSeconds: 600 });
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(600);
  });

  it("trues a reservation up to the measured duration, up or down", async () => {
    await reserveMeetingProcessing(workspaceId, "import:a", 0, { audioSeconds: 100 });
    expect(await adjustReservedAudioSeconds(workspaceId, "import:a", 250)).toBe(true);
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(250);
    expect(await adjustReservedAudioSeconds(workspaceId, "import:a", 40.2)).toBe(true);
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(41);
  });

  it("refuses to grow past the plan's audio hours and leaves the reservation untouched", async () => {
    const limit = PLAN_AUDIO_HOUR_LIMITS.hosted_pro * 3_600;
    await reserveMeetingProcessing(workspaceId, "import:other", 0, { audioSeconds: limit - 100 });
    await reserveMeetingProcessing(workspaceId, "import:a", 0, { audioSeconds: 50 });
    await expect(adjustReservedAudioSeconds(workspaceId, "import:a", 200)).rejects.toBeInstanceOf(AudioBudgetError);
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(limit - 50);
    // Exactly filling the cap is allowed.
    await expect(adjustReservedAudioSeconds(workspaceId, "import:a", 100)).resolves.toBe(true);
  });

  it("does nothing for a released or missing reservation", async () => {
    await reserveMeetingProcessing(workspaceId, "import:a", 0, { audioSeconds: 100 });
    await releaseMeetingProcessing(workspaceId, "import:a");
    expect(await adjustReservedAudioSeconds(workspaceId, "import:a", 300)).toBe(false);
    expect(await adjustReservedAudioSeconds(workspaceId, "import:missing", 300)).toBe(false);
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(0);
  });

  it("keeps live-capture reservations on the byte formula", async () => {
    // 1 second of two-channel 48 kHz 16-bit PCM is 192,000 bytes.
    await reserveMeetingProcessing(workspaceId, "capture:a", 192_000 * 10);
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(10);
  });
});

describe("import upload creation", () => {
  const workspaceId = randomUUID();
  const meetingIds: string[] = [];

  async function meeting(): Promise<string> {
    const id = randomUUID();
    meetingIds.push(id);
    await prisma.meeting.create({
      data: { id, userId: "import-user", workspaceId, title: "Import test", startedAt: new Date(), endedAt: new Date(), summary: "", captureSource: "import", processingMode: "managed" },
    });
    return id;
  }

  beforeEach(async () => {
    await prisma.workspace.create({ data: { id: workspaceId, name: "Import upload workspace" } });
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
  });

  afterEach(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  });

  it("stores the kind, format and declared duration and replays idempotently", async () => {
    const meetingId = await meeting();
    const input = { meetingId, totalChunks: 2, totalBytes: 5_000_000, idempotencyKey: "import:one", kind: "import" as const, sourceFormat: "mp3", declaredDurationSeconds: 900 };
    const first = await createManagedUpload(workspaceId, input);
    const second = await createManagedUpload(workspaceId, input);
    expect(second.id).toBe(first.id);
    expect(await prisma.managedUpload.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ kind: "import", sourceFormat: "mp3", declaredDurationSeconds: 900 });
  });

  it("refuses unsupported formats, missing formats and out-of-range durations", async () => {
    const meetingId = await meeting();
    const base = { meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "import:bad", kind: "import" as const };
    await expect(createManagedUpload(workspaceId, { ...base, sourceFormat: "exe" })).rejects.toBeInstanceOf(ManagedValidationError);
    await expect(createManagedUpload(workspaceId, { ...base })).rejects.toBeInstanceOf(ManagedValidationError);
    await expect(createManagedUpload(workspaceId, { ...base, sourceFormat: "mp3", declaredDurationSeconds: 0 })).rejects.toBeInstanceOf(ManagedValidationError);
    await expect(createManagedUpload(workspaceId, { ...base, sourceFormat: "mp3", declaredDurationSeconds: 1.5 })).rejects.toBeInstanceOf(ManagedValidationError);
    await expect(createManagedUpload(workspaceId, { ...base, sourceFormat: "mp3", totalBytes: MAX_UPLOAD_BYTES + 1 })).rejects.toBeInstanceOf(ManagedValidationError);
  });

  it("refuses a single file longer than the plan allows", async () => {
    const meetingId = await meeting();
    const tooLong = PLAN_IMPORT_MAX_SECONDS.hosted_pro + 1;
    await expect(createManagedUpload(workspaceId, {
      meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "import:long", kind: "import", sourceFormat: "wav", declaredDurationSeconds: tooLong,
    })).rejects.toThrow(/over 4 hours/);
  });

  it("refuses an import that cannot fit in the remaining audio hours before any bytes are staged", async () => {
    const limit = PLAN_AUDIO_HOUR_LIMITS.hosted_pro * 3_600;
    await reserveMeetingProcessing(workspaceId, "import:used", 0, { audioSeconds: limit - 60 });
    const meetingId = await meeting();
    await expect(createManagedUpload(workspaceId, {
      meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "import:big", kind: "import", sourceFormat: "mp3", declaredDurationSeconds: 600,
    })).rejects.toBeInstanceOf(AudioBudgetError);
    expect(await prisma.managedUpload.count({ where: { workspaceId } })).toBe(0);
  });

  it("does not reuse a live-capture manifest for an import under the same key", async () => {
    const meetingId = await meeting();
    await createManagedUpload(workspaceId, { meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "shared-key" });
    await expect(createManagedUpload(workspaceId, {
      meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "shared-key", kind: "import", sourceFormat: "mp3",
    })).rejects.toThrow("idempotency key conflicts");
  });

  it("reserves the import estimate when the job is queued, not the byte formula", async () => {
    const meetingId = await meeting();
    const upload = await createManagedUpload(workspaceId, {
      meetingId, totalChunks: 1, totalBytes: 1_000_000, idempotencyKey: "import:queue", kind: "import", sourceFormat: "m4a", declaredDurationSeconds: 600,
    });
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { status: "complete", completedAt: new Date() } });
    await enqueueManagedJob(workspaceId, meetingId, upload.id, "job-import-queue");
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(600);
  });

  it("removes the placeholder meeting of an import abandoned past its expiry", async () => {
    const meetingId = await meeting();
    const upload = await createManagedUpload(workspaceId, {
      meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "import:abandoned", kind: "import", sourceFormat: "mp3",
    });
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expireManagedUploads();
    expect(await prisma.managedUpload.count({ where: { id: upload.id } })).toBe(0);
    expect(await prisma.meeting.count({ where: { id: meetingId } })).toBe(0);
  });

  it("keeps a meeting that already has content when its import upload expires", async () => {
    const meetingId = await meeting();
    await prisma.meeting.update({ where: { id: meetingId }, data: { summary: "Real notes" } });
    const upload = await createManagedUpload(workspaceId, {
      meetingId, totalChunks: 1, totalBytes: 1_000, idempotencyKey: "import:kept", kind: "import", sourceFormat: "mp3",
    });
    await prisma.managedUpload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expireManagedUploads();
    expect(await prisma.meeting.count({ where: { id: meetingId } })).toBe(1);
  });
});

describe.skipIf(!HAVE_FFMPEG)("import worker pipeline", () => {
  const STARTED_AT = new Date("2026-09-24T15:00:00.000Z");
  let storageDir: string;
  let fixtureDir: string;
  let workspaceId: string;
  let meetingId: string;
  let uploadId: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-import-fixture-"));
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  function fixture(name: string, args: string[]): string {
    const out = path.join(fixtureDir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, out], { stdio: "pipe" });
    return out;
  }

  /** Stages `file` as an import upload split into two chunks and queues its job. */
  async function setup(file: string, plan: "hosted_pro" | "hosted_trial" = "hosted_pro", declaredDurationSeconds = 1) {
    workspaceId = randomUUID();
    meetingId = randomUUID();
    uploadId = randomUUID();
    storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-import-storage-"));
    for (const name of ["OBJECT_STORAGE_DIR", "MANAGED_TRANSCRIPTION_PROVIDER", "MANAGED_IMPORT_TRANSCRIPTION_PROVIDER", "MANAGED_DEEPGRAM_API_KEY", "MANAGED_GROQ_API_KEY", "MANAGED_SUMMARY_PROVIDER", "MANAGED_OPENAI_API_KEY"]) saved[name] = process.env[name];
    process.env.OBJECT_STORAGE_DIR = storageDir;
    process.env.MANAGED_TRANSCRIPTION_PROVIDER = "groq";
    delete process.env.MANAGED_IMPORT_TRANSCRIPTION_PROVIDER;
    process.env.MANAGED_GROQ_API_KEY = "test-groq-key";
    process.env.MANAGED_SUMMARY_PROVIDER = "openai";
    process.env.MANAGED_OPENAI_API_KEY = "test-openai-key";

    await prisma.workspace.create({ data: { id: workspaceId, name: "Import pipeline workspace" } });
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan, status: plan === "hosted_trial" ? "trialing" : "active" } });
    await prisma.meeting.create({
      data: { id: meetingId, userId: "import-user", workspaceId, title: "Meeting on 2026-09-24", startedAt: STARTED_AT, endedAt: STARTED_AT, summary: "", captureSource: "import", processingMode: "managed" },
    });
    const bytes = await readFile(file);
    const middle = Math.floor(bytes.length / 2);
    const parts = [bytes.subarray(0, middle), bytes.subarray(middle)];
    await prisma.managedUpload.create({
      data: {
        id: uploadId, workspaceId, meetingId, idempotencyKey: `import:${uploadId}`, totalChunks: parts.length, totalBytes: bytes.length,
        status: "complete", kind: "import", sourceFormat: path.extname(file).slice(1), declaredDurationSeconds,
        expiresAt: new Date(Date.now() + 3_600_000), completedAt: new Date(),
      },
    });
    for (const [index, part] of parts.entries()) {
      const objectKey = `uploads/${workspaceId}/${uploadId}/${index}-import.chunk`;
      await putObject(objectKey, new Uint8Array(part));
      await prisma.uploadChunk.create({ data: { uploadId, chunkIndex: index, channel: "speaker", byteLength: part.length, checksum: `import-${index}`, objectKey } });
    }
    return (await enqueueManagedJob(workspaceId, meetingId, uploadId, `import:${uploadId}`)).id;
  }

  afterEach(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await rm(storageDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  const SUMMARY_RESPONSE = () => new Response(JSON.stringify({
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ title: "Imported call", overview: "A recording.", key_points: ["Point"], decisions: [], action_items: [{ text: "Follow up" }] }) }] }],
  }), { status: 200 });

  it("decodes, trues up usage to the real duration, transcribes 16 kHz audio and stores unlabelled speakers", async () => {
    const jobId = await setup(fixture("pipeline.mp3", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", "-ar", "44100"]));
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(1); // the client's under-declared estimate

    const wavHeaders: number[] = [];
    const groqSizes: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("api.groq.com")) {
        const file = (init?.body as FormData).get("file") as File;
        groqSizes.push(file.size);
        wavHeaders.push(new DataView(await file.arrayBuffer()).getUint32(24, true));
        return new Response(JSON.stringify({ duration: 3, segments: [{ start: 0, end: 2, text: "hello from a file" }] }), { status: 200 });
      }
      if (url.includes("api.openai.com/v1/responses")) return SUMMARY_RESPONSE();
      return new Response("unexpected provider", { status: 500 });
    });

    await runManagedJob(workspaceId, jobId);

    expect(wavHeaders).toEqual([16_000]);
    expect(groqSizes[0]).toBeGreaterThan(90_000); // about three seconds of 16 kHz 16-bit mono
    const usage = (await getEntitlements(workspaceId)).audio.usedSeconds;
    expect(usage).toBeGreaterThanOrEqual(3);
    expect(usage).toBeLessThanOrEqual(4);

    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "complete", stage: null });
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { transcript: true, actionItems: true } });
    expect(meeting.transcript.map(({ speaker, text }) => [speaker, text])).toEqual([["speaker", "hello from a file"]]);
    expect(meeting.title).toBe("Imported call");
    expect(meeting.actionItems.map((item) => item.text)).toEqual(["Follow up"]);
    expect(meeting.endedAt.getTime() - meeting.startedAt.getTime()).toBeGreaterThanOrEqual(2_900);
    // The staged original is deleted once notes are saved.
    expect(await prisma.uploadChunk.count({ where: { uploadId } })).toBe(0);
    await expect(getObject(`uploads/${workspaceId}/${uploadId}/0-import.chunk`)).rejects.toBeDefined();
  });

  it("extracts audio from a video file", async () => {
    const jobId = await setup(fixture("pipeline.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "mpeg4", "-c:a", "aac", "-shortest"]), "hosted_pro", 3);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.groq.com")) return new Response(JSON.stringify({ duration: 3, segments: [{ start: 0, end: 1, text: "from a video" }] }), { status: 200 });
      if (url.includes("api.openai.com/v1/responses")) return SUMMARY_RESPONSE();
      return new Response("unexpected provider", { status: 500 });
    });
    await runManagedJob(workspaceId, jobId);
    expect(await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "complete" });
  });

  it("maps Deepgram's diarized voices to Speaker N when the operator opts in", async () => {
    const jobId = await setup(fixture("diarize.mp3", ["-f", "lavfi", "-i", "sine=duration=3"]), "hosted_pro", 3);
    // setup() resets provider env to the Groq defaults, so opt in afterwards.
    process.env.MANAGED_IMPORT_TRANSCRIPTION_PROVIDER = "deepgram";
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    let deepgramUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.deepgram.com")) {
        deepgramUrl = url;
        return new Response(JSON.stringify({ metadata: { duration: 3 }, results: { utterances: [
          { start: 0, end: 1, transcript: "first voice", speaker: 4 },
          { start: 1, end: 2, transcript: "second voice", speaker: 7 },
        ] } }), { status: 200 });
      }
      if (url.includes("api.openai.com/v1/responses")) return SUMMARY_RESPONSE();
      return new Response("unexpected provider", { status: 500 });
    });
    await runManagedJob(workspaceId, jobId);
    expect(deepgramUrl).toContain("sample_rate=16000");
    expect(deepgramUrl).toContain("diarize=true");
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { transcript: { orderBy: { order: "asc" } } } });
    expect(meeting.transcript.map((segment) => segment.speaker)).toEqual(["speaker-1", "speaker-2"]);
  });

  it("fails before any provider spend when the measured length exceeds the audio hours left, and refunds", async () => {
    const jobId = await setup(fixture("over-budget.mp3", ["-f", "lavfi", "-i", "sine=duration=3"]));
    // Leave only one second of the plan's audio hours free, besides this job's own estimate.
    const limit = PLAN_AUDIO_HOUR_LIMITS.hosted_pro * 3_600;
    await prisma.usageLedgerEntry.create({ data: { workspaceId, periodStart: new Date(), kind: "meeting_processing", units: 1, audioSeconds: limit - 2, idempotencyKey: "other-usage" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not be called", { status: 500 }));

    await expect(runManagedJob(workspaceId, jobId)).rejects.toThrow("longer than the audio time left");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({
      status: "error",
      stage: null,
      errorMessage: expect.stringContaining("longer than the audio time left"),
    });
    const entry = await prisma.usageLedgerEntry.findFirstOrThrow({ where: { workspaceId, idempotencyKey: `import:${uploadId}` } });
    expect(entry.units).toBe(0);
  });

  it("fails an over-long file for a trial plan before decoding or any provider call", async () => {
    const trialMax = PLAN_IMPORT_MAX_SECONDS.hosted_trial;
    const jobId = await setup(fixture("long.mp3", ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", String(trialMax + 5), "-b:a", "8k"]), "hosted_trial", 60);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(runManagedJob(workspaceId, jobId)).rejects.toThrow("longer than");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(0);
  }, 60_000);

  it("fails a corrupt file with a user-safe message, keeps the upload for retry and refunds", async () => {
    const corrupt = path.join(fixtureDir, "corrupt.mp3");
    await writeFile(corrupt, randomBytes(5_000));
    const jobId = await setup(corrupt);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(runManagedJob(workspaceId, jobId)).rejects.toThrow();

    expect(fetchSpy).not.toHaveBeenCalled();
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("error");
    expect(job.errorMessage).toMatch(/couldn't be read|couldn't be decoded|isn't supported/);
    expect(job.errorMessage).not.toMatch(/ffmpeg|ffprobe|\/tmp/i);
    expect(await prisma.uploadChunk.count({ where: { uploadId } })).toBe(2); // staged until expiry so Retry can run again
    expect((await getEntitlements(workspaceId)).audio.usedSeconds).toBe(0);
  });

  it("does not charge for a file with no speech", async () => {
    const jobId = await setup(fixture("silence.mp3", ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "2"]), "hosted_pro", 2);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("api.groq.com")) return new Response(JSON.stringify({ duration: 2, segments: [] }), { status: 200 });
      return new Response("unexpected provider", { status: 500 });
    });
    await runManagedJob(workspaceId, jobId);
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.summary).toBe("No speech detected");
    expect((await getEntitlements(workspaceId)).used).toBe(0);
  });
});
