import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { LANGUAGES, isLanguageCode, languageCodeFromName, languageName, parseVocabulary, vocabularyPrompt, MAX_VOCABULARY_TERMS, MAX_VOCABULARY_TERM_LENGTH } from "./languages";
import { updateLanguageSettings } from "./languageSettings";
import { enqueueManagedJob } from "./managedJobs";
import { NOTE_TEMPLATES } from "./noteTemplates";
import { deepgramLanguageParams, runManagedJob, summarySystemPrompt } from "./managedWorker";
import { regenerateNotes } from "./notesRegenerate";
import { putObject } from "./objectStorage";

describe("languages", () => {
  it("knows its codes and names, and maps Whisper's English names back to codes", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(20);
    expect(isLanguageCode("es")).toBe(true);
    expect(isLanguageCode("xx")).toBe(false);
    expect(isLanguageCode("toString")).toBe(false);
    expect(languageName("fr")).toBe("French");
    expect(languageName("xx")).toBeNull();
    expect(languageName(null)).toBeNull();
    expect(languageCodeFromName("Spanish")).toBe("es");
    expect(languageCodeFromName("mandarin")).toBe("zh");
    expect(languageCodeFromName("de")).toBe("de");
    expect(languageCodeFromName("klingon")).toBeNull();
    expect(languageCodeFromName(undefined)).toBeNull();
  });
});

describe("vocabulary", () => {
  it("splits on lines, commas and semicolons, trims, dedupes ignoring case and drops control characters", () => {
    expect(parseVocabulary("Acme Corp\n kubernetes ,Kubernetes;  Dr. Nguyen\n\n\u0007Bell\n")).toEqual(["Acme Corp", "kubernetes", "Dr. Nguyen", "Bell"]);
  });

  it("bounds term count and length", () => {
    const many = Array.from({ length: 150 }, (_, index) => `term${index}`).join("\n");
    expect(parseVocabulary(many)).toHaveLength(MAX_VOCABULARY_TERMS);
    expect(parseVocabulary("x".repeat(100))[0]).toHaveLength(MAX_VOCABULARY_TERM_LENGTH);
  });

  it("builds a Whisper prompt that stays within its length budget", () => {
    expect(vocabularyPrompt(["Acme", "QBR"])).toBe("Acme, QBR");
    expect(vocabularyPrompt([])).toBe("");
    const prompt = vocabularyPrompt(Array.from({ length: 100 }, (_, index) => `longer-term-${index}`), 100);
    expect(prompt.length).toBeLessThanOrEqual(100);
    expect(prompt.endsWith(",")).toBe(false);
  });

  it("encodes Deepgram language and key-term parameters, detecting the language when none is given", () => {
    expect(deepgramLanguageParams({ terms: [], language: null })).toBe("&detect_language=true");
    expect(deepgramLanguageParams({ terms: ["Acme Corp", "R&D"], language: "es" })).toBe("&language=es&keyterm=Acme%20Corp&keyterm=R%26D");
    expect(deepgramLanguageParams({ terms: Array.from({ length: 80 }, (_, index) => `t${index}`), language: null }).match(/keyterm=/g)).toHaveLength(50);
  });
});

describe("summary prompt", () => {
  it("asks for the chosen language including section headings, and lists the vocabulary", () => {
    const prompt = summarySystemPrompt("2026-09-30", NOTE_TEMPLATES.sales, false, { language: "es", vocabulary: ["Acme Corp", "QBR"] });
    expect(prompt).toContain("in Spanish, whatever language the transcript is in");
    expect(prompt).toContain("section headings");
    expect(prompt).toContain("Acme Corp, QBR");
    expect(prompt).toContain("untrusted data");
  });

  it("adds nothing when no language or terms are set", () => {
    const prompt = summarySystemPrompt("2026-09-30");
    expect(prompt).not.toMatch(/whatever language|Spell these names/);
  });
});

describe("workspace language settings and processing", () => {
  const STARTED_AT = new Date("2026-09-24T15:00:00.000Z");
  const saved: Record<string, string | undefined> = {};
  let workspaceId: string;
  let storageDir: string;
  const owner = () => ({ workspaceId, userId: "lang-owner", role: "owner" as const });

  beforeEach(async () => {
    for (const name of ["MANAGED_HOSTING", "OBJECT_STORAGE_DIR", "MANAGED_TRANSCRIPTION_PROVIDER", "MANAGED_GROQ_API_KEY", "MANAGED_DEEPGRAM_API_KEY", "MANAGED_SUMMARY_PROVIDER", "MANAGED_OPENAI_API_KEY"]) saved[name] = process.env[name];
    process.env.MANAGED_HOSTING = "true";
    process.env.MANAGED_SUMMARY_PROVIDER = "openai";
    process.env.MANAGED_OPENAI_API_KEY = "test-openai-key";
    storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-lang-"));
    process.env.OBJECT_STORAGE_DIR = storageDir;
    workspaceId = randomUUID();
    await prisma.workspace.create({ data: { id: workspaceId, name: "Language workspace" } });
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
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

  it("lets only an owner save normalised terms and a valid language, and audits without the terms", async () => {
    expect(await updateLanguageSettings({ ...owner(), role: "member" }, { vocabulary: "Acme", summaryLanguage: "" })).toMatchObject({ ok: false });
    expect(await updateLanguageSettings(owner(), { vocabulary: "Acme\n acme \nQBR", summaryLanguage: "es" })).toEqual({ ok: true, terms: 2 });
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).toMatchObject({ vocabulary: "Acme\nQBR", summaryLanguage: "es" });
    expect(await updateLanguageSettings(owner(), { vocabulary: "", summaryLanguage: "" })).toEqual({ ok: true, terms: 0 });
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).toMatchObject({ vocabulary: "", summaryLanguage: null });
    expect(await updateLanguageSettings(owner(), { vocabulary: "x", summaryLanguage: "klingon" })).toMatchObject({ ok: false });
    expect(await updateLanguageSettings(owner(), { vocabulary: ",,;", summaryLanguage: "" })).toMatchObject({ ok: false });
    expect(await updateLanguageSettings(owner(), { vocabulary: "x".repeat(20_001), summaryLanguage: "" })).toMatchObject({ ok: false });
    const audits = await prisma.auditEvent.findMany({ where: { workspaceId, action: "workspace.language_update" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((event) => event.metadata)).toEqual([{ terms: 2, language: "es" }, { terms: 0, language: "same" }]);
    expect(JSON.stringify(audits)).not.toContain("Acme");
  });

  async function queueCapture(meeting: { language?: string }) {
    const meetingId = randomUUID();
    await prisma.meeting.create({ data: { id: meetingId, userId: "u", workspaceId, title: "Meeting on 2026-09-24", startedAt: STARTED_AT, endedAt: STARTED_AT, summary: "", processingMode: "managed", ...meeting } });
    const uploadId = randomUUID();
    await prisma.managedUpload.create({ data: { id: uploadId, workspaceId, meetingId, idempotencyKey: `u-${uploadId}`, totalChunks: 1, totalBytes: 4, status: "complete", expiresAt: new Date(Date.now() + 3_600_000), completedAt: new Date() } });
    const objectKey = `uploads/${workspaceId}/${uploadId}/0-l.chunk`;
    await putObject(objectKey, new Uint8Array([0, 0, 0, 0]));
    await prisma.uploadChunk.create({ data: { uploadId, chunkIndex: 0, channel: "mic", byteLength: 4, checksum: "l", objectKey } });
    return { meetingId, jobId: (await enqueueManagedJob(workspaceId, meetingId, uploadId, `job-${meetingId}`)).id };
  }

  const summaryResponse = (overview = "Overview.") => new Response(JSON.stringify({
    status: "completed", usage: { input_tokens: 1, output_tokens: 1 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ title: "Título", overview, key_points: [], decisions: [], sections: [], action_items: [] }) }] }],
  }), { status: 200 });

  it("sends the vocabulary to Whisper, detects the language, stores it, and writes the summary in the chosen language", async () => {
    process.env.MANAGED_TRANSCRIPTION_PROVIDER = "groq";
    process.env.MANAGED_GROQ_API_KEY = "test-groq-key";
    await updateLanguageSettings(owner(), { vocabulary: "Acme Corp\nQBR", summaryLanguage: "fr" });
    const { meetingId, jobId } = await queueCapture({});
    let groqForm: FormData | undefined;
    let instructions = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("api.groq.com")) {
        groqForm = init!.body as FormData;
        return new Response(JSON.stringify({ language: "spanish", duration: 1, segments: [{ start: 0, end: 1, text: "hola equipo" }] }), { status: 200 });
      }
      if (url.includes("api.openai.com/v1/responses")) {
        instructions = JSON.parse(String(init!.body)).instructions;
        return summaryResponse();
      }
      return new Response("unexpected", { status: 500 });
    });

    await runManagedJob(workspaceId, jobId);

    expect(groqForm!.get("prompt")).toBe("Acme Corp, QBR");
    expect(groqForm!.get("language")).toBeNull(); // not chosen, so Whisper detects it
    expect(instructions).toContain("in French");
    expect(instructions).toContain("Acme Corp, QBR");
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).language).toBe("es");
  });

  it("uses a chosen spoken language as the Whisper hint and keeps it over detection", async () => {
    process.env.MANAGED_TRANSCRIPTION_PROVIDER = "groq";
    process.env.MANAGED_GROQ_API_KEY = "test-groq-key";
    const { meetingId, jobId } = await queueCapture({ language: "de" });
    let groqForm: FormData | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("api.groq.com")) {
        groqForm = init!.body as FormData;
        return new Response(JSON.stringify({ language: "english", duration: 1, segments: [{ start: 0, end: 1, text: "hello" }] }), { status: 200 });
      }
      return summaryResponse();
    });
    await runManagedJob(workspaceId, jobId);
    expect(groqForm!.get("language")).toBe("de");
    expect(groqForm!.get("prompt")).toBeNull(); // no vocabulary set
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).language).toBe("de");
  });

  it("sends Deepgram the detect/keyterm parameters and stores its detected language", async () => {
    process.env.MANAGED_TRANSCRIPTION_PROVIDER = "deepgram";
    process.env.MANAGED_DEEPGRAM_API_KEY = "test-deepgram-key";
    await updateLanguageSettings(owner(), { vocabulary: "Acme Corp", summaryLanguage: "" });
    const { meetingId, jobId } = await queueCapture({});
    let deepgramUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.deepgram.com")) {
        deepgramUrl = url;
        return new Response(JSON.stringify({ metadata: { duration: 2 }, results: { channels: [{ detected_language: "pt" }], utterances: [{ start: 0, end: 1, transcript: "olá a todos" }] } }), { status: 200 });
      }
      return summaryResponse();
    });
    await runManagedJob(workspaceId, jobId);
    expect(deepgramUrl).toContain("detect_language=true");
    expect(deepgramUrl).toContain("keyterm=Acme%20Corp");
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).language).toBe("pt");
  });

  it("regenerates notes in a chosen language and rejects an unknown one without calling the provider", async () => {
    const meeting = await prisma.meeting.create({
      data: { userId: "u", workspaceId, title: "Quarterly call", summary: "Old", processingMode: "managed", startedAt: STARTED_AT, endedAt: STARTED_AT,
        transcript: { create: [{ userId: "u", speaker: "you", text: "Let's renew.", timestamp: STARTED_AT, order: 0 }] } },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await regenerateNotes({ workspaceId, userId: "u" }, meeting.id, "general", { summaryLanguage: "klingon" })).toMatchObject({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    let instructions = "";
    fetchSpy.mockImplementation(async (_input, init) => {
      instructions = JSON.parse(String(init!.body)).instructions;
      return summaryResponse("Resumen en español.");
    });
    expect((await regenerateNotes({ workspaceId, userId: "u" }, meeting.id, "general", { summaryLanguage: "es" })).ok).toBe(true);
    expect(instructions).toContain("in Spanish");
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).summary).toContain("Resumen en español.");
  });
});
