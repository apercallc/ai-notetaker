import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { enqueueManagedJob } from "./managedJobs";
import { prisma } from "./db";
import { getEntitlements } from "./usageLedger";
import { putObject } from "./objectStorage";
import {
  DEFAULT_MANAGED_SUMMARY_MODEL,
  MANAGED_JOB_LEASE_MS,
  ManagedWorkerError,
  formatSummaryText,
  isPlaceholderTitle,
  managedSummaryModel,
  mergeUtterances,
  nextManagedJob,
  parseDeepgramUtterances,
  parseSummary,
  providerRequest,
  runManagedJob,
  summaryFromResponse,
} from "./managedWorker";

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
  it("maps Deepgram diarization to you / them-1..n with start offsets", () => {
    const speaker = parseDeepgramUtterances({
      metadata: { duration: 12.5 },
      results: { utterances: [
        { start: 0.4, end: 3.1, transcript: " Hello there ", speaker: 3 },
        { start: 3.5, end: 5, transcript: "Second voice", speaker: 0 },
        { start: 6, end: 7, transcript: "First voice again", speaker: 3 },
        { start: 8, end: 9, transcript: "   " },
      ] },
    }, "them");
    expect(speaker.durationMs).toBe(12_500);
    expect(speaker.utterances).toEqual([
      { speaker: "them-1", text: "Hello there", startMs: 400, endMs: 3_100 },
      { speaker: "them-2", text: "Second voice", startMs: 3_500, endMs: 5_000 },
      { speaker: "them-1", text: "First voice again", startMs: 6_000, endMs: 7_000 },
    ]);
    const mic = parseDeepgramUtterances({ results: { utterances: [{ start: 1, end: 2, transcript: "mine", speaker: 1 }] } }, "you");
    expect(mic.utterances[0]).toMatchObject({ speaker: "you", startMs: 1_000 });
    expect(mic.durationMs).toBe(2_000);
  });

  it("falls back to the channel transcript when Deepgram returns no utterances", () => {
    expect(parseDeepgramUtterances({ results: { channels: [{ alternatives: [{ transcript: "  hello there  " }] }] } }, "you").utterances).toEqual([
      { speaker: "you", text: "hello there", startMs: 0, endMs: 0 },
    ]);
    expect(parseDeepgramUtterances({ results: { channels: [] } }, "them")).toEqual({ utterances: [], durationMs: 0 });
    expect(parseDeepgramUtterances("garbage", "you")).toEqual({ utterances: [], durationMs: 0 });
  });

  it("merges both channels chronologically", () => {
    const merged = mergeUtterances(
      [{ speaker: "you", text: "b", startMs: 5_000, endMs: 6_000 }, { speaker: "you", text: "d", startMs: 9_000, endMs: 9_500 }],
      [{ speaker: "them-1", text: "a", startMs: 1_000, endMs: 2_000 }, { speaker: "them-2", text: "c", startMs: 5_000, endMs: 6_000 }],
    );
    expect(merged.map((utterance) => utterance.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("validates structured summaries and tolerates malformed entries", () => {
    const parsed = parseSummary({
      title: "  Launch   plan ",
      overview: "We agreed on Friday.",
      key_points: ["one", 4, "  "],
      decisions: ["ship Friday"],
      action_items: [{ text: "Send the draft", owner: "Sam", due: "2026-10-02" }, { text: "No owner", owner: null, due: "next week" }, { text: 4 }, "junk"],
    });
    expect(parsed).toMatchObject({ title: "Launch plan", overview: "We agreed on Friday.", keyPoints: ["one"], decisions: ["ship Friday"] });
    expect(parsed.actionItems).toEqual([
      { text: "Send the draft", owner: "Sam", dueAt: new Date("2026-10-02T00:00:00.000Z") },
      { text: "No owner" },
    ]);
    expect(parseSummary({ summary: "legacy shape", actionItems: [{ text: "follow up", owner: "Sam" }] })).toMatchObject({ overview: "legacy shape", actionItems: [{ text: "follow up", owner: "Sam" }] });
    expect(() => parseSummary({ actionItems: [] })).toThrow(ManagedWorkerError);
    expect(() => parseSummary("nope")).toThrow(ManagedWorkerError);
    expect(formatSummaryText(parsed)).toBe("We agreed on Friday.\n\nKey points\n- one\n\nDecisions\n- ship Friday");
  });

  it("reads the tool call, then JSON text, then raw text from a model response", () => {
    const input = { title: "T", overview: "From the tool", key_points: [], decisions: [], action_items: [] };
    expect(summaryFromResponse({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "record_meeting_notes", input }] }).overview).toBe("From the tool");
    expect(summaryFromResponse({ content: [{ type: "text", text: "```json\n{\"overview\":\"From fenced JSON\"}\n```" }] }).overview).toBe("From fenced JSON");
    expect(summaryFromResponse({ content: [{ type: "text", text: "Here you go: {\"overview\":\"Embedded\"} thanks" }] }).overview).toBe("Embedded");
    const raw = summaryFromResponse({ content: [{ type: "text", text: "The meeting covered budgets." }] });
    expect(raw).toMatchObject({ title: null, overview: "The meeting covered budgets.", actionItems: [] });
    expect(() => summaryFromResponse({ content: [] })).toThrow(ManagedWorkerError);
  });

  it("uses one configurable summary model constant that is not the retired alias", () => {
    expect(managedSummaryModel({})).toBe(DEFAULT_MANAGED_SUMMARY_MODEL);
    expect(managedSummaryModel({ MANAGED_SUMMARY_MODEL: "  custom-model " })).toBe("custom-model");
    expect(DEFAULT_MANAGED_SUMMARY_MODEL).not.toContain("claude-3");
  });

  it("only replaces auto-generated titles", () => {
    expect(isPlaceholderTitle("Meeting on 2026-09-24")).toBe(true);
    expect(isPlaceholderTitle("Meet - abc-defg-hij")).toBe(true);
    expect(isPlaceholderTitle("")).toBe(true);
    expect(isPlaceholderTitle("Quarterly planning with Dana")).toBe(false);
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

describe("managed worker pipeline", () => {
  const STARTED_AT = new Date("2026-09-24T15:00:00.000Z");
  let storageDir: string;
  let workspaceId: string;
  let meetingId: string;
  let jobId: string;
  const saved: Record<string, string | undefined> = {};

  async function setup(options: { title?: string; channels?: ("mic" | "speaker")[] } = {}) {
    workspaceId = randomUUID();
    meetingId = randomUUID();
    const uploadId = randomUUID();
    storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-managed-pipeline-"));
    for (const name of ["OBJECT_STORAGE_DIR", "MANAGED_DEEPGRAM_API_KEY", "MANAGED_ANTHROPIC_API_KEY", "MANAGED_SUMMARY_MODEL"]) saved[name] = process.env[name];
    process.env.OBJECT_STORAGE_DIR = storageDir;
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    process.env.MANAGED_ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.MANAGED_SUMMARY_MODEL;
    await prisma.workspace.create({ data: { id: workspaceId, name: "Pipeline workspace" } });
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
    await prisma.meeting.create({
      data: { id: meetingId, userId: "pipeline-user", workspaceId, title: options.title ?? "Meeting on 2026-09-24", startedAt: STARTED_AT, endedAt: new Date("2026-09-24T15:00:05.000Z"), summary: "" },
    });
    const channels = options.channels ?? ["mic", "speaker"];
    await prisma.managedUpload.create({
      data: { id: uploadId, workspaceId, meetingId, idempotencyKey: `upload-${uploadId}`, totalChunks: channels.length, totalBytes: channels.length, status: "complete", expiresAt: new Date(Date.now() + 3_600_000), completedAt: new Date() },
    });
    for (const [index, channel] of channels.entries()) {
      const objectKey = `uploads/${workspaceId}/${uploadId}/${index}-pipeline-${channel}.chunk`;
      await putObject(objectKey, new Uint8Array([index + 1]));
      await prisma.uploadChunk.create({ data: { uploadId, chunkIndex: index, channel, byteLength: 1, checksum: `pipeline-${channel}`, objectKey } });
    }
    jobId = (await enqueueManagedJob(workspaceId, meetingId, uploadId, `job-${meetingId}`)).id;
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

  function mockProviders(handlers: { deepgram: (call: number, url: string) => unknown; anthropic?: () => Response }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    let deepgramCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("api.deepgram.com")) {
        deepgramCalls += 1;
        return new Response(JSON.stringify(handlers.deepgram(deepgramCalls, url)), { status: 200 });
      }
      if (url.includes("api.anthropic.com") && handlers.anthropic) return handlers.anthropic();
      return new Response("unexpected provider", { status: 500 });
    });
    return calls;
  }

  it("stores chronological diarized utterances, the recording duration, a generated title, structured notes and cost", async () => {
    await setup();
    const calls = mockProviders({
      // Channel order in the worker is mic then speaker, but calls resolve concurrently:
      // distinguish by the request's audio via the call order recorded below.
      deepgram: (call) => call === 1
        ? { metadata: { duration: 65 }, results: { utterances: [{ start: 12, end: 15, transcript: "I will send the draft" }, { start: 61, end: 64, transcript: "Thanks everyone" }] } }
        : { metadata: { duration: 64 }, results: { utterances: [{ start: 2, end: 8, transcript: "Welcome, let's start", speaker: 0 }, { start: 20, end: 25, transcript: "Please send it by Friday", speaker: 1 }] } },
      anthropic: () => new Response(JSON.stringify({
        usage: { input_tokens: 1_000, output_tokens: 200 },
        content: [{ type: "tool_use", name: "record_meeting_notes", input: {
          title: "Draft review and Friday deadline",
          overview: "The draft is due Friday.",
          key_points: ["Draft owed by Friday"],
          decisions: ["Ship on Friday"],
          action_items: [{ text: "Send the draft", owner: "You", due: "2026-09-25" }],
        } }],
      }), { status: 200 }),
    });

    await expect(runManagedJob(workspaceId, jobId)).resolves.toBeUndefined();

    const deepgramUrl = calls.find((call) => call.url.includes("deepgram"))!.url;
    for (const parameter of ["utterances=true", "smart_format=true", "diarize=true", "model=nova-3"]) expect(deepgramUrl).toContain(parameter);
    const anthropicBody = JSON.parse(String(calls.find((call) => call.url.includes("anthropic"))!.init!.body)) as { model: string; tools: { name: string }[]; messages: { content: string }[] };
    expect(anthropicBody.model).toBe(DEFAULT_MANAGED_SUMMARY_MODEL);
    expect(anthropicBody.tools[0]?.name).toBe("record_meeting_notes");
    expect(anthropicBody.messages[0]?.content).toContain("[00:02] Them 1: Welcome, let's start");

    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { transcript: { orderBy: { order: "asc" } }, actionItems: true } });
    expect(meeting).toMatchObject({
      title: "Draft review and Friday deadline",
      summary: "The draft is due Friday.\n\nKey points\n- Draft owed by Friday\n\nDecisions\n- Ship on Friday",
      processingMode: "managed",
    });
    // endedAt is startedAt + recording duration, not the processing wall clock.
    expect(meeting.endedAt.toISOString()).toBe("2026-09-24T15:01:05.000Z");
    expect(meeting.transcript.map((segment) => [segment.speaker, segment.text, segment.timestamp.toISOString()])).toEqual([
      ["them-1", "Welcome, let's start", "2026-09-24T15:00:02.000Z"],
      ["you", "I will send the draft", "2026-09-24T15:00:12.000Z"],
      ["them-2", "Please send it by Friday", "2026-09-24T15:00:20.000Z"],
      ["you", "Thanks everyone", "2026-09-24T15:01:01.000Z"],
    ]);
    expect(meeting.actionItems).toMatchObject([{ text: "Send the draft", owner: "You", userId: "pipeline-user" }]);
    expect(meeting.actionItems[0]?.dueAt?.toISOString()).toBe("2026-09-25T00:00:00.000Z");

    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "complete", errorMessage: null });
    // 129s of audio across both channels + 1000 input / 200 output tokens.
    expect(job.providerCostMicros).toBeGreaterThan(2_000 + 2_000);
    expect((await getEntitlements(workspaceId)).used).toBe(1);
  });

  it("keeps a title the user chose", async () => {
    await setup({ title: "Quarterly planning with Dana", channels: ["mic"] });
    mockProviders({
      deepgram: () => ({ results: { utterances: [{ start: 0, end: 2, transcript: "hello", speaker: 0 }] } }),
      anthropic: () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_meeting_notes", input: { title: "Generated", overview: "o", key_points: [], decisions: [], action_items: [] } }] }), { status: 200 }),
    });
    await runManagedJob(workspaceId, jobId);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).title).toBe("Quarterly planning with Dana");
  });

  it("skips the LLM for an empty transcript, marks it No speech detected and does not consume the allowance", async () => {
    await setup();
    const calls = mockProviders({ deepgram: () => ({ metadata: { duration: 30 }, results: { utterances: [] , channels: [{ alternatives: [{ transcript: "" }] }] } }) });
    await runManagedJob(workspaceId, jobId);
    expect(calls.some((call) => call.url.includes("anthropic"))).toBe(false);
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { transcript: true, actionItems: true } });
    expect(meeting).toMatchObject({ summary: "No speech detected", processingMode: "managed", transcript: [], actionItems: [] });
    expect(meeting.endedAt.toISOString()).toBe("2026-09-24T15:00:30.000Z");
    expect(await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "complete" });
    expect((await getEntitlements(workspaceId)).used).toBe(0);
  });

  it("tolerates malformed model output instead of failing the job", async () => {
    await setup({ channels: ["speaker"] });
    mockProviders({
      deepgram: () => ({ results: { utterances: [{ start: 1, end: 3, transcript: "budget is approved", speaker: 0 }] } }),
      anthropic: () => new Response(JSON.stringify({ content: [{ type: "text", text: "Sorry, here is a plain summary: the budget was approved." }] }), { status: 200 }),
    });
    await runManagedJob(workspaceId, jobId);
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { actionItems: true } });
    expect(meeting.summary).toBe("Sorry, here is a plain summary: the budget was approved.");
    expect(meeting.actionItems).toEqual([]);
    expect(await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "complete" });
  });

  it("persists a user-safe error message and releases usage when a provider fails", async () => {
    await setup({ channels: ["mic"] });
    mockProviders({ deepgram: () => ({ results: { utterances: [{ start: 0, end: 1, transcript: "hi" }] } }), anthropic: () => new Response("bad request", { status: 400 }) });
    await expect(runManagedJob(workspaceId, jobId)).rejects.toThrow("summary provider returned 400");
    expect(await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "error", errorMessage: "summary provider returned 400" });
    expect((await getEntitlements(workspaceId)).used).toBe(0);
  });

  it("hides internal error details from the persisted job message", async () => {
    await setup({ channels: ["mic"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new TypeError("connect ECONNREFUSED 10.0.0.5:5432 secret-host"); });
    await expect(runManagedJob(workspaceId, jobId)).rejects.toThrow("transcription provider request failed");
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.errorMessage).toBe("transcription provider request failed");
    expect(job.errorMessage).not.toContain("secret-host");
  });
});
