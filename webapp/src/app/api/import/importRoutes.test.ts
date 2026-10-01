import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as startImport } from "./route";
import { PUT as putChunk } from "./[uploadId]/chunks/[chunkIndex]/route";
import { POST as finishImport } from "./[uploadId]/complete/route";
import { prisma } from "@/lib/db";
import { getEntitlements } from "@/lib/usageLedger";
import { PUT as putManagedChunk } from "../v1/uploads/[uploadId]/chunks/[chunkIndex]/route";
import { POST as createManagedUploadRoute } from "../v1/uploads/route";

const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const ORIGIN = "http://localhost";

const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();
let sessionId: string;
let otherSessionId: string;
let storageDir: string;
const saved: Record<string, string | undefined> = {};

async function principal(workspaceId: string, email: string): Promise<string> {
  const user = await prisma.user.create({ data: { id: randomUUID(), email, passwordHash: "test-hash", emailVerifiedAt: new Date() } });
  await prisma.workspaceMembership.create({ data: { userId: user.id, workspaceId, role: "owner" } });
  return (await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) } })).id;
}

function browserHeaders(session: string, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, "x-notetaker-browser": "1", cookie: `session=${session}`, ...extra };
}

function post(pathname: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function startBody(overrides: Record<string, unknown> = {}) {
  return { meetingId: randomUUID(), idempotencyKey: `import:${randomUUID()}`, fileName: "standup.mp3", totalBytes: 3_000_000, durationSeconds: 120, ...overrides };
}

beforeEach(async () => {
  for (const name of ["MANAGED_HOSTING", "OBJECT_STORAGE_DIR", "MANAGED_WORKER_TOKEN"]) saved[name] = process.env[name];
  process.env.MANAGED_HOSTING = "true";
  // No token: finishing an import queues the job without pushing it to a worker.
  delete process.env.MANAGED_WORKER_TOKEN;
  storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-import-route-"));
  process.env.OBJECT_STORAGE_DIR = storageDir;
  await prisma.workspace.createMany({ data: [{ id: WORKSPACE_ID, name: "Import route workspace" }, { id: OTHER_WORKSPACE_ID, name: "Other import workspace" }] });
  await prisma.workspaceSubscription.createMany({ data: [
    { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" },
    { workspaceId: OTHER_WORKSPACE_ID, plan: "hosted_pro", status: "active" },
  ] });
  sessionId = await principal(WORKSPACE_ID, `import-${randomUUID()}@example.test`);
  otherSessionId = await principal(OTHER_WORKSPACE_ID, `import-other-${randomUUID()}@example.test`);
});

afterEach(async () => {
  // Meetings carry a plain workspace id (no foreign key), so remove them explicitly.
  await prisma.meeting.deleteMany({ where: { workspaceId: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "import-" } } });
  await rm(storageDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("browser import API authentication", () => {
  it("rejects a request without the session cookie", async () => {
    const { cookie: _cookie, ...headers } = browserHeaders(sessionId);
    expect((await startImport(post("/api/import", startBody(), headers))).status).toBe(401);
  });

  it("rejects a cross-site request even with a valid cookie (CSRF)", async () => {
    const response = await startImport(post("/api/import", startBody(), browserHeaders(sessionId, { origin: "https://evil.example" })));
    expect(response.status).toBe(401);
    expect(await prisma.meeting.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(0);
  });

  it("rejects a request with no Origin header", async () => {
    const { origin: _origin, ...headers } = browserHeaders(sessionId);
    expect((await startImport(post("/api/import", startBody(), headers))).status).toBe(401);
  });

  it("rejects a request without the browser-API header", async () => {
    const { "x-notetaker-browser": _marker, ...headers } = browserHeaders(sessionId);
    expect((await startImport(post("/api/import", startBody(), headers))).status).toBe(401);
  });

  it("does not accept a Bearer token in place of the cookie", async () => {
    const headers = { origin: ORIGIN, "x-notetaker-browser": "1", authorization: `Bearer ${sessionId}` };
    expect((await startImport(post("/api/import", startBody(), headers))).status).toBe(401);
  });

  it("is unavailable when managed hosting is off", async () => {
    process.env.MANAGED_HOSTING = "false";
    expect((await startImport(post("/api/import", startBody(), browserHeaders(sessionId)))).status).toBe(401);
  });

  it("rejects a session that must change its password first", async () => {
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    await prisma.user.update({ where: { id: session.userId }, data: { mustChangePassword: true } });
    expect((await startImport(post("/api/import", startBody(), browserHeaders(sessionId)))).status).toBe(401);
  });
});

describe.skipIf(!HAVE_FFMPEG)("browser import flow", () => {
  it("registers a meeting and a metered upload, accepts chunks and queues the job", async () => {
    const body = startBody();
    const response = await startImport(post("/api/import", body, browserHeaders(sessionId)));
    expect(response.status).toBe(201);
    const started = await response.json() as { uploadId: string; meetingId: string; totalChunks: number; chunkBytes: number; receivedChunks: number[]; estimatedSeconds: number };
    expect(started.meetingId).toBe(body.meetingId);
    expect(started.totalChunks).toBe(1);
    expect(started.estimatedSeconds).toBe(120);
    expect(started.receivedChunks).toEqual([]);

    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: body.meetingId } });
    expect(meeting).toMatchObject({ workspaceId: WORKSPACE_ID, captureSource: "import", processingMode: "managed", summary: "" });
    expect(meeting.title).toMatch(/^Meeting on \d{4}-\d{2}-\d{2}$/); // placeholder, so the generated title replaces it

    // Same key resumes the same upload.
    const replay = await (await startImport(post("/api/import", body, browserHeaders(sessionId)))).json() as { uploadId: string };
    expect(replay.uploadId).toBe(started.uploadId);

    const bytes = Buffer.alloc(3_000_000, 7);
    const chunk = await putChunk(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/chunks/0`, {
        method: "PUT",
        headers: { ...browserHeaders(sessionId), "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex") },
        body: bytes,
      }),
      { params: Promise.resolve({ uploadId: started.uploadId, chunkIndex: "0" }) },
    );
    expect(chunk.status).toBe(201);

    const resumed = await (await startImport(post("/api/import", body, browserHeaders(sessionId)))).json() as { receivedChunks: number[] };
    expect(resumed.receivedChunks).toEqual([0]);

    const done = await finishImport(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/complete`, { method: "POST", headers: browserHeaders(sessionId) }),
      { params: Promise.resolve({ uploadId: started.uploadId }) },
    );
    expect(done.status).toBe(202);
    const finished = await done.json() as { meetingId: string; jobId: string; status: string };
    expect(finished).toMatchObject({ meetingId: body.meetingId, status: "queued" });

    // The import counts against the plan: one meeting plus the declared audio time.
    const entitlements = await getEntitlements(WORKSPACE_ID);
    expect(entitlements.used).toBe(1);
    expect(entitlements.audio.usedSeconds).toBe(120);
    expect(await prisma.processingJob.findUniqueOrThrow({ where: { id: finished.jobId } })).toMatchObject({ uploadId: started.uploadId, status: "queued" });

    // Completing twice does not charge twice.
    await finishImport(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/complete`, { method: "POST", headers: browserHeaders(sessionId) }),
      { params: Promise.resolve({ uploadId: started.uploadId }) },
    );
    expect((await getEntitlements(WORKSPACE_ID)).audio.usedSeconds).toBe(120);
  });

  it("stores the chosen notes template as the meeting's mode and rejects unknown ones", async () => {
    const body = startBody({ template: "lecture" });
    expect((await startImport(post("/api/import", body, browserHeaders(sessionId)))).status).toBe(201);
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: body.meetingId } })).toMatchObject({ mode: "lecture" });

    for (const template of ["bogus", "custom"]) {
      const response = await startImport(post("/api/import", startBody({ template }), browserHeaders(sessionId)));
      expect(response.status).toBe(400);
    }
    expect(await prisma.meeting.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(1);
  });

  it("refuses unsupported file types and oversized files", async () => {
    const exe = await startImport(post("/api/import", startBody({ fileName: "setup.exe" }), browserHeaders(sessionId)));
    expect(exe.status).toBe(400);
    expect((await exe.json() as { error: string }).error).toContain("isn't supported");
    const huge = await startImport(post("/api/import", startBody({ totalBytes: 2_500_000_000 }), browserHeaders(sessionId)));
    expect(huge.status).toBe(400);
    expect(await prisma.meeting.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(0);
  });

  it("answers 402 and registers nothing when the plan has no audio time left", async () => {
    await prisma.usageLedgerEntry.create({
      data: { workspaceId: WORKSPACE_ID, periodStart: new Date(), kind: "meeting_processing", units: 1, audioSeconds: 60 * 3_600 - 10, idempotencyKey: "used-up" },
    });
    const response = await startImport(post("/api/import", startBody({ durationSeconds: 600 }), browserHeaders(sessionId)));
    expect(response.status).toBe(402);
    expect(await prisma.managedUpload.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(0);
    // A refused import must not leave an empty meeting in the list.
    expect(await prisma.meeting.count({ where: { workspaceId: WORKSPACE_ID } })).toBe(0);
  });

  it("frees the staging slot when the minutes run out between starting and finishing an import", async () => {
    const body = startBody({ durationSeconds: 120 });
    const started = await (await startImport(post("/api/import", body, browserHeaders(sessionId)))).json() as { uploadId: string };
    const bytes = Buffer.alloc(3_000_000, 7);
    await putChunk(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/chunks/0`, {
        method: "PUT",
        headers: { ...browserHeaders(sessionId), "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex") },
        body: bytes,
      }),
      { params: Promise.resolve({ uploadId: started.uploadId, chunkIndex: "0" }) },
    );
    // Another upload used the remaining minutes meanwhile.
    await prisma.usageLedgerEntry.create({
      data: { workspaceId: WORKSPACE_ID, periodStart: new Date(), kind: "meeting_processing", units: 1, audioSeconds: 60 * 3_600, idempotencyKey: `drained-${started.uploadId}` },
    });

    const finish = await finishImport(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/complete`, { method: "POST", headers: browserHeaders(sessionId) }),
      { params: Promise.resolve({ uploadId: started.uploadId }) },
    );

    expect(finish.status).toBe(402);
    expect(await prisma.uploadChunk.count({ where: { uploadId: started.uploadId } })).toBe(0);
    expect(await prisma.managedUpload.findUniqueOrThrow({ where: { id: started.uploadId } })).toMatchObject({ status: "expired" });
  });

  it("does not let another workspace upload to or finish an import it does not own", async () => {
    const started = await (await startImport(post("/api/import", startBody(), browserHeaders(sessionId)))).json() as { uploadId: string };
    const bytes = Buffer.alloc(1_000, 1);
    const chunk = await putChunk(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/chunks/0`, {
        method: "PUT",
        headers: { ...browserHeaders(otherSessionId), "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex") },
        body: bytes,
      }),
      { params: Promise.resolve({ uploadId: started.uploadId, chunkIndex: "0" }) },
    );
    expect(chunk.status).toBe(400);
    const finish = await finishImport(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/complete`, { method: "POST", headers: browserHeaders(otherSessionId) }),
      { params: Promise.resolve({ uploadId: started.uploadId }) },
    );
    expect(finish.status).toBe(400);
    expect(await prisma.uploadChunk.count({ where: { uploadId: started.uploadId } })).toBe(0);
  });

  it("will not write a cookie-authenticated chunk into a live-capture upload", async () => {
    const meetingId = randomUUID();
    await prisma.meeting.create({ data: { id: meetingId, userId: "u", workspaceId: WORKSPACE_ID, title: "Live", startedAt: new Date(), endedAt: new Date(), summary: "" } });
    const created = await createManagedUploadRoute(new Request(`${ORIGIN}/api/v1/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionId}`, "content-type": "application/json" },
      body: JSON.stringify({ meetingId, totalChunks: 1, totalBytes: 100, idempotencyKey: `live-${meetingId}` }),
    }));
    const { uploadId } = await created.json() as { uploadId: string };
    const bytes = Buffer.alloc(100, 2);
    const response = await putChunk(
      new Request(`${ORIGIN}/api/import/${uploadId}/chunks/0`, {
        method: "PUT",
        headers: { ...browserHeaders(sessionId), "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex") },
        body: bytes,
      }),
      { params: Promise.resolve({ uploadId, chunkIndex: "0" }) },
    );
    expect(response.status).toBe(400);
    // The extension's Bearer route is unaffected and still accepts it.
    const bearer = await putManagedChunk(
      new Request(`${ORIGIN}/api/v1/uploads/${uploadId}/chunks/0`, {
        method: "PUT",
        headers: { authorization: `Bearer ${sessionId}`, "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex") },
        body: bytes,
      }),
      { params: Promise.resolve({ uploadId, chunkIndex: "0" }) },
    );
    expect(bearer.status).toBe(201);
  });

  it("refuses a bad chunk checksum", async () => {
    const started = await (await startImport(post("/api/import", startBody(), browserHeaders(sessionId)))).json() as { uploadId: string };
    const response = await putChunk(
      new Request(`${ORIGIN}/api/import/${started.uploadId}/chunks/0`, {
        method: "PUT",
        headers: { ...browserHeaders(sessionId), "x-chunk-sha256": "0".repeat(64) },
        body: Buffer.alloc(1_000, 1),
      }),
      { params: Promise.resolve({ uploadId: started.uploadId, chunkIndex: "0" }) },
    );
    expect(response.status).toBe(400);
  });
});
