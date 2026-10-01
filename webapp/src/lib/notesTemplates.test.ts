import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { enqueueManagedJob } from "./managedJobs";
import { formatSummaryText, parseSummary, runManagedJob, summarySystemPrompt } from "./managedWorker";
import { MAX_NOTES_REGENERATIONS, NOTE_TEMPLATES, PICKABLE_TEMPLATES, isNoteTemplateId, noteTemplateFor } from "./noteTemplates";
import { regenerateNotes } from "./notesRegenerate";
import { putObject } from "./objectStorage";

describe("note templates", () => {
  it("offers six templates and every non-general one defines sections and guidance", () => {
    expect(PICKABLE_TEMPLATES.map((template) => template.id)).toEqual(["general", "standup", "sales", "one_on_one", "interview", "lecture"]);
    for (const template of PICKABLE_TEMPLATES.filter((item) => item.id !== "general")) {
      expect(template.sections.length).toBeGreaterThanOrEqual(3);
      expect(template.guidance.length).toBeGreaterThan(20);
      expect(new Set(template.sections.map((section) => section.heading)).size).toBe(template.sections.length);
    }
  });

  it("falls back to General for unknown or legacy values", () => {
    expect(noteTemplateFor("nonsense").id).toBe("general");
    expect(noteTemplateFor(null).id).toBe("general");
    expect(noteTemplateFor("custom").sections).toEqual([]);
    expect(isNoteTemplateId("lecture")).toBe(true);
    expect(isNoteTemplateId("toString")).toBe(false);
  });

  it("keeps the interview template away from hire/no-hire judgments and protected traits", () => {
    expect(NOTE_TEMPLATES.interview.guidance).toMatch(/do not recommend hiring/i);
    expect(NOTE_TEMPLATES.interview.guidance).toMatch(/protected characteristics/i);
  });
});

describe("summary prompt and output with templates", () => {
  it("lists the template's headings in order and keeps the transcript-is-untrusted rule", () => {
    const prompt = summarySystemPrompt("2026-09-30", NOTE_TEMPLATES.sales);
    const order = ["Customer needs", "Objections and concerns", "Budget, timeline and decision makers", "Next steps"].map((heading) => prompt.indexOf(heading));
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain("untrusted data");
  });

  it("asks General for an empty sections array", () => {
    expect(summarySystemPrompt("2026-09-30")).toContain('"sections" must be an empty array');
  });

  it("parses sections, dropping empty, malformed and over-long entries", () => {
    const parsed = parseSummary({
      overview: "Overview",
      sections: [
        { heading: "Next steps", items: ["Send quote", "", 5, "Book demo"] },
        { heading: "Empty", items: [] },
        { heading: "", items: ["no heading"] },
        "bad",
        { heading: "x".repeat(200), items: ["kept, heading truncated"] },
      ],
    });
    expect(parsed.sections.map((section) => section.heading)).toEqual(["Next steps", "x".repeat(80)]);
    expect(parsed.sections[0]!.items).toEqual(["Send quote", "Book demo"]);
  });

  it("accepts a summary that only has sections, and renders them as markdown headings", () => {
    const parsed = parseSummary({ sections: [{ heading: "Key concepts", items: ["Entropy"] }] });
    expect(formatSummaryText(parsed)).toBe("## Key concepts\n- Entropy");
  });
});

const SALES_SUMMARY = {
  title: "Acme renewal call",
  overview: "Acme wants to renew.",
  key_points: ["Renewal discussed"],
  decisions: [],
  sections: [
    { heading: "Customer needs", items: ["Faster onboarding"] },
    { heading: "Next steps", items: ["Send the quote by Friday"] },
  ],
  action_items: [{ text: "Send the quote", owner: "You", due: null }, { text: "Book a demo", owner: null, due: null }],
};

function openAiResponse(summary: unknown): Response {
  return new Response(JSON.stringify({
    status: "completed",
    usage: { input_tokens: 10, output_tokens: 5 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(summary) }] }],
  }), { status: 200 });
}

describe("template-aware processing and regeneration", () => {
  const STARTED_AT = new Date("2026-09-24T15:00:00.000Z");
  const saved: Record<string, string | undefined> = {};
  let storageDir: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  const userId = "templates-user";

  async function meeting(options: { mode?: string; processingMode?: string; withTranscript?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await prisma.meeting.create({
      data: {
        id, userId, workspaceId, title: "Quarterly call", mode: options.mode ?? "general", processingMode: options.processingMode ?? "managed",
        startedAt: STARTED_AT, endedAt: new Date(STARTED_AT.getTime() + 60_000), summary: "Old summary",
        ...(options.withTranscript === false ? {} : {
          transcript: { create: [
            { userId, speaker: "you", text: "Let's renew for another year.", timestamp: new Date(STARTED_AT.getTime() + 1_000), order: 0 },
            { userId, speaker: "them-1", text: "We need faster onboarding.", timestamp: new Date(STARTED_AT.getTime() + 9_000), order: 1 },
          ] },
        }),
      },
    });
    return id;
  }

  beforeEach(async () => {
    for (const name of ["MANAGED_HOSTING", "OBJECT_STORAGE_DIR", "MANAGED_TRANSCRIPTION_PROVIDER", "MANAGED_DEEPGRAM_API_KEY", "MANAGED_SUMMARY_PROVIDER", "MANAGED_OPENAI_API_KEY"]) saved[name] = process.env[name];
    process.env.MANAGED_HOSTING = "true";
    process.env.MANAGED_SUMMARY_PROVIDER = "openai";
    process.env.MANAGED_OPENAI_API_KEY = "test-openai-key";
    storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-templates-"));
    process.env.OBJECT_STORAGE_DIR = storageDir;
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await prisma.workspace.createMany({ data: [{ id: workspaceId, name: "Templates workspace" }, { id: otherWorkspaceId, name: "Other templates workspace" }] });
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await rm(storageDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("summarizes a hosted meeting with its template and stores the sections", async () => {
    process.env.MANAGED_TRANSCRIPTION_PROVIDER = "deepgram";
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    const meetingId = await meeting({ mode: "sales", withTranscript: false });
    const uploadId = randomUUID();
    await prisma.managedUpload.create({
      data: { id: uploadId, workspaceId, meetingId, idempotencyKey: `u-${uploadId}`, totalChunks: 1, totalBytes: 4, status: "complete", expiresAt: new Date(Date.now() + 3_600_000), completedAt: new Date() },
    });
    const objectKey = `uploads/${workspaceId}/${uploadId}/0-t.chunk`;
    await putObject(objectKey, new Uint8Array([1, 2, 3, 4]));
    await prisma.uploadChunk.create({ data: { uploadId, chunkIndex: 0, channel: "mic", byteLength: 4, checksum: "t", objectKey } });
    const jobId = (await enqueueManagedJob(workspaceId, meetingId, uploadId, `job-${meetingId}`)).id;

    let summaryRequest: { instructions: string; text: { format: { schema: { properties: Record<string, unknown>; required: string[] } } } } | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("api.deepgram.com")) return new Response(JSON.stringify({ metadata: { duration: 5 }, results: { utterances: [{ start: 0, end: 2, transcript: "Let's renew." }] } }), { status: 200 });
      if (url.includes("api.openai.com/v1/responses")) {
        summaryRequest = JSON.parse(String(init!.body));
        return openAiResponse(SALES_SUMMARY);
      }
      return new Response("unexpected", { status: 500 });
    });

    await runManagedJob(workspaceId, jobId);

    expect(summaryRequest!.instructions).toContain("Next steps");
    expect(summaryRequest!.text.format.schema.properties).toHaveProperty("sections");
    expect(summaryRequest!.text.format.schema.required).toContain("sections");
    const stored = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(stored.summary).toContain("## Customer needs\n- Faster onboarding");
    expect(stored.summary).toContain("## Next steps\n- Send the quote by Friday");
  });

  it("rewrites the summary with the new template, keeps action items and adds only new ones", async () => {
    const meetingId = await meeting({ mode: "general" });
    const done = await prisma.actionItem.create({ data: { meetingId, userId, text: "Send the quote", status: "done", owner: "Sam" } });
    let instructions = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      instructions = JSON.parse(String(init!.body)).instructions;
      return openAiResponse(SALES_SUMMARY);
    });

    const result = await regenerateNotes({ workspaceId, userId }, meetingId, "sales");

    expect(result).toEqual({ ok: true, template: "sales", remaining: MAX_NOTES_REGENERATIONS - 1 });
    expect(instructions).toContain("Customer needs");
    const stored = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { actionItems: true } });
    const items = [...stored.actionItems].sort((a, b) => a.text.localeCompare(b.text));
    expect(stored).toMatchObject({ mode: "sales", notesRegenerations: 1 });
    expect(stored.title).toBe("Quarterly call"); // a user-chosen title is never replaced
    expect(stored.summary).toContain("## Next steps");
    expect(stored.summary).not.toContain("Old summary");
    // The completed item survives untouched; the duplicate is not re-added; the new one is.
    expect(items.map((item) => [item.text, item.status])).toEqual([["Book a demo", "open"], ["Send the quote", "done"]]);
    expect(items[1]!.id).toBe(done.id);
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId, action: "meeting.regenerate_notes" } })).toMatchObject({ actorUserId: userId, targetId: meetingId, metadata: { template: "sales" } });
  });

  it("allows exactly three rewrites per meeting and makes no provider call after that", async () => {
    const meetingId = await meeting();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => openAiResponse(SALES_SUMMARY));
    for (let attempt = 0; attempt < MAX_NOTES_REGENERATIONS; attempt += 1) {
      expect((await regenerateNotes({ workspaceId, userId }, meetingId, "lecture")).ok).toBe(true);
    }
    const fourth = await regenerateNotes({ workspaceId, userId }, meetingId, "lecture");
    expect(fourth).toMatchObject({ ok: false, error: expect.stringContaining("3 times") });
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_NOTES_REGENERATIONS);
  });

  it("does not use up a rewrite when the provider fails, and leaves the notes alone", async () => {
    const meetingId = await meeting();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await regenerateNotes({ workspaceId, userId }, meetingId, "standup");
    expect(result.ok).toBe(false);
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).toMatchObject({ notesRegenerations: 0, summary: "Old summary", mode: "general" });
  });

  it("never shows a server setting name to the user when a credential is missing", async () => {
    const meetingId = await meeting();
    delete process.env.MANAGED_OPENAI_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await regenerateNotes({ workspaceId, userId }, meetingId, "sales");
    expect(result).toEqual({ ok: false, error: "Couldn't regenerate the notes. Try again in a moment." });
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).toMatchObject({ notesRegenerations: 0 });
  });

  it("refuses unsupported cases with a clear message and no provider call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const managed = await meeting();
    const local = await meeting({ processingMode: "local_byok" });
    const empty = await meeting({ withTranscript: false });
    const busy = await meeting();
    await prisma.managedUpload.create({ data: { id: randomUUID(), workspaceId, meetingId: busy, idempotencyKey: "busy", totalChunks: 1, totalBytes: 1, status: "complete", expiresAt: new Date(Date.now() + 1_000_000) } });
    const upload = await prisma.managedUpload.findFirstOrThrow({ where: { meetingId: busy } });
    await prisma.processingJob.create({ data: { workspaceId, meetingId: busy, uploadId: upload.id, idempotencyKey: "busy-job", status: "processing" } });

    expect(await regenerateNotes({ workspaceId, userId }, managed, "custom")).toMatchObject({ ok: false, error: expect.stringContaining("listed templates") });
    expect(await regenerateNotes({ workspaceId, userId }, managed, "nope")).toMatchObject({ ok: false });
    expect(await regenerateNotes({ workspaceId, userId }, local, "sales")).toMatchObject({ ok: false, error: expect.stringContaining("hosted service") });
    expect(await regenerateNotes({ workspaceId, userId }, empty, "sales")).toMatchObject({ ok: false, error: expect.stringContaining("transcript") });
    expect(await regenerateNotes({ workspaceId, userId }, busy, "sales")).toMatchObject({ ok: false, error: expect.stringContaining("still being processed") });
    expect(await regenerateNotes({ workspaceId: otherWorkspaceId, userId }, managed, "sales")).toMatchObject({ ok: false, error: expect.stringContaining("no longer exists") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires an active plan and hosted mode", async () => {
    const meetingId = await meeting();
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "canceled" } });
    expect(await regenerateNotes({ workspaceId, userId }, meetingId, "sales")).toMatchObject({ ok: false, error: expect.stringContaining("Plans & usage") });
    process.env.MANAGED_HOSTING = "false";
    expect(await regenerateNotes({ workspaceId, userId }, meetingId, "sales")).toMatchObject({ ok: false, error: expect.stringContaining("aren't enabled") });
  });
});
