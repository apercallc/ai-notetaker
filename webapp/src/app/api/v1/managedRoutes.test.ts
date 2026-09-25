import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createUpload } from "./uploads/route";
import { POST as managedLogin } from "./auth/login/route";
import { GET as getEntitlements } from "./entitlements/route";
import { PUT as putChunk } from "./uploads/[uploadId]/chunks/[chunkIndex]/route";
import { POST as completeUpload } from "./uploads/[uploadId]/complete/route";
import { POST as enqueueJob } from "./meetings/[meetingId]/process/route";
import { GET as getJob } from "./jobs/[jobId]/route";
import { POST as pollNextJob } from "./jobs/next/route";
import { POST as checkout } from "./billing/checkout/route";
import { POST as portal } from "./billing/portal/route";
import { POST as billingWebhook } from "./billing/webhook/route";
import { prisma } from "@/lib/db";
import { MAX_CHUNK_BYTES } from "@/lib/managedJobs";
import { hashPassword } from "@/lib/passwords";

const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
let storageDir: string;
const originalStorageDir = process.env.OBJECT_STORAGE_DIR;
const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const originalHostedProPrice = process.env.STRIPE_PRICE_HOSTED_PRO;
const originalManagedHosting = process.env.MANAGED_HOSTING;

function auth(sessionId: string): HeadersInit {
  return { authorization: `Bearer ${sessionId}`, "content-type": "application/json" };
}

function authForWorkspace(sessionId: string, workspaceId: string): HeadersInit {
  return { ...auth(sessionId), "x-workspace-id": workspaceId };
}

async function createPrincipal(userId: string, email: string, workspaceId: string, role = "owner"): Promise<string> {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "test-hash", emailVerifiedAt: new Date() } });
  await prisma.workspaceMembership.create({ data: { userId, workspaceId, role } });
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1_000) },
  });
  return session.id;
}

beforeEach(async () => {
  process.env.MANAGED_HOSTING = "true";
  storageDir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-managed-route-"));
  process.env.OBJECT_STORAGE_DIR = storageDir;
  process.env.MANAGED_WORKER_TOKEN = "route-worker-token";
  await prisma.workspace.createMany({
    data: [
      { id: WORKSPACE_ID, name: "Route test workspace" },
      { id: OTHER_WORKSPACE_ID, name: "Other route workspace" },
    ],
  });
});

afterEach(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
  await prisma.user.deleteMany({ where: { id: { in: [USER_ID, OTHER_USER_ID] } } });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.MANAGED_WORKER_TOKEN;
  if (originalStorageDir === undefined) delete process.env.OBJECT_STORAGE_DIR;
  else process.env.OBJECT_STORAGE_DIR = originalStorageDir;
  if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
  if (originalHostedProPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_PRO;
  else process.env.STRIPE_PRICE_HOSTED_PRO = originalHostedProPrice;
  if (originalManagedHosting === undefined) delete process.env.MANAGED_HOSTING;
  else process.env.MANAGED_HOSTING = originalManagedHosting;
});

describe("managed upload routes", () => {
  it("does not expose managed sign-in when the deployment is self-hosted", async () => {
    delete process.env.MANAGED_HOSTING;
    const response = await managedLogin(new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "irrelevant" }),
    }));
    expect(response.status).toBe(404);
  });

  it("logs a managed client in before any session exists", async () => {
    const password = "correct horse battery staple";
    await prisma.user.create({ data: { id: USER_ID, email: "login-route@example.com", passwordHash: await hashPassword(password), emailVerifiedAt: new Date() } });
    await prisma.workspaceMembership.create({ data: { userId: USER_ID, workspaceId: WORKSPACE_ID, role: "owner" } });

    const response = await managedLogin(new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "login-route@example.com", password }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accountId: USER_ID, workspaceId: WORKSPACE_ID, plan: "local", role: "owner" });
  });

  it("applies the shared database login throttle to extension/API sign-in", async () => {
    const email = "throttled-api-login@example.com";
    await prisma.loginThrottle.create({
      data: { emailKey: email, failures: 10, firstFailureAt: new Date(), updatedAt: new Date() },
    });

    const response = await managedLogin(new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong password" }),
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "invalid credentials" }));
    await prisma.loginThrottle.delete({ where: { emailKey: email } });
  });

  it("returns workspace-scoped entitlements for a managed client preflight", async () => {
    const sessionId = await createPrincipal(USER_ID, "entitlements-route@example.com", WORKSPACE_ID);
    await prisma.workspaceSubscription.create({ data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" } });
    const response = await getEntitlements(new Request("http://localhost/api/v1/entitlements", { headers: auth(sessionId) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ plan: "hosted_pro", status: "active", canProcess: true, remaining: 1_000 });
  });

  it("includes the request correlation id on managed authentication failures", async () => {
    const response = await getEntitlements(new Request("http://localhost/api/v1/entitlements", {
      headers: { "x-request-id": "managed-auth-test" },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("managed-auth-test");
    expect(await response.json()).toEqual({ error: "managed session required", requestId: "managed-auth-test" });
  });

  it("protects the worker poll and returns an empty 204 when the queue is idle", async () => {
    const unauthorized = await pollNextJob(new Request("http://localhost/api/v1/jobs/next", { method: "POST" }));
    expect(unauthorized.status).toBe(401);

    const idle = await pollNextJob(new Request("http://localhost/api/v1/jobs/next", {
      method: "POST",
      headers: { "x-worker-token": "route-worker-token" },
    }));
    expect(idle.status).toBe(204);
    expect(await idle.text()).toBe("");
  });

  it("honors an explicitly selected workspace only when the session is a member", async () => {
    const sessionId = await createPrincipal(USER_ID, "multi-workspace@example.com", WORKSPACE_ID);
    await prisma.workspaceMembership.create({ data: { userId: USER_ID, workspaceId: OTHER_WORKSPACE_ID, role: "member" } });
    const meetingId = randomUUID();
    await prisma.meeting.create({
      data: {
        id: meetingId,
        userId: USER_ID,
        workspaceId: OTHER_WORKSPACE_ID,
        title: "Second workspace meeting",
        startedAt: new Date("2026-09-24T15:00:00.000Z"),
        endedAt: new Date("2026-09-24T15:30:00.000Z"),
        summary: "",
      },
    });

    const selected = await createUpload(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: authForWorkspace(sessionId, OTHER_WORKSPACE_ID),
        body: JSON.stringify({ meetingId, totalChunks: 1, totalBytes: 1, idempotencyKey: `selected-${meetingId}` }),
      }),
    );
    expect(selected.status).toBe(201);

    const nonMemberWorkspace = await createUpload(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: authForWorkspace(sessionId, randomUUID()),
        body: JSON.stringify({ meetingId, totalChunks: 1, totalBytes: 1, idempotencyKey: `default-${meetingId}` }),
      }),
    );
    expect(nonMemberWorkspace.status).toBe(401);
  });

  it("keeps the full upload and job lifecycle workspace-scoped", async () => {
    const sessionId = await createPrincipal(USER_ID, "route-owner@example.com", WORKSPACE_ID);
    const otherSessionId = await createPrincipal(OTHER_USER_ID, "other-owner@example.com", OTHER_WORKSPACE_ID);
    const meetingId = randomUUID();
    await prisma.meeting.create({
      data: {
        id: meetingId,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        title: "Route meeting",
        startedAt: new Date("2026-09-24T15:00:00.000Z"),
        endedAt: new Date("2026-09-24T15:30:00.000Z"),
        summary: "",
      },
    });

    const manifest = { meetingId, totalChunks: 2, totalBytes: 8, idempotencyKey: `route-${meetingId}` };
    const created = await createUpload(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: auth(sessionId),
        body: JSON.stringify(manifest),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { uploadId: string };

    const replay = await createUpload(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: auth(sessionId),
        body: JSON.stringify(manifest),
      }),
    );
    expect(replay.status).toBe(201);
    expect((await replay.json()).uploadId).toBe(createdBody.uploadId);

    const otherTenant = await createUpload(
      new Request("http://localhost/api/v1/uploads", {
        method: "POST",
        headers: auth(otherSessionId),
        body: JSON.stringify(manifest),
      }),
    );
    expect(otherTenant.status).toBe(400);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const oversized = new Uint8Array(MAX_CHUNK_BYTES + 1);
    const oversizedChunk = await putChunk(
      new Request("http://localhost/api/v1/uploads/chunk", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "x-audio-channel": "mic",
          "x-chunk-sha256": "unused",
        },
        body: oversized,
      }),
      chunkContextFor(createdBody.uploadId, 0),
    );
    expect(oversizedChunk.status).toBe(400);

    const mismatchedChunk = await putChunk(
      new Request("http://localhost/api/v1/uploads/chunk", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "x-audio-channel": "mic",
          "x-chunk-sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: bytes,
      }),
      chunkContextFor(createdBody.uploadId, 0),
    );
    expect(mismatchedChunk.status).toBe(400);

    const chunkRequest = () =>
      new Request("http://localhost/api/v1/uploads/chunk", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "x-audio-channel": "mic",
          "x-chunk-sha256": checksum,
        },
        body: bytes,
      });
    const chunkContext = chunkContextFor(createdBody.uploadId, 0);
    const chunk = await putChunk(chunkRequest(), chunkContext);
    expect(chunk.status).toBe(201);
    const replayedChunk = await putChunk(chunkRequest(), chunkContext);
    expect(replayedChunk.status).toBe(200);
    await expect(replayedChunk.json()).resolves.toMatchObject({ replayed: true });

    const secondBytes = new Uint8Array([5, 6, 7, 8]);
    const secondChecksum = createHash("sha256").update(secondBytes).digest("hex");
    const secondChunkRequest = () =>
      new Request("http://localhost/api/v1/uploads/chunk", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${sessionId}`,
          "x-audio-channel": "speaker",
          "x-chunk-sha256": secondChecksum,
        },
        body: secondBytes,
      });
    const secondChunkContext = chunkContextFor(createdBody.uploadId, 1);
    const concurrentRetries = await Promise.all([putChunk(secondChunkRequest(), secondChunkContext), putChunk(secondChunkRequest(), secondChunkContext)]);
    expect(concurrentRetries.map((response) => response.status).sort()).toEqual([200, 201]);
    const concurrentBodies = await Promise.all(concurrentRetries.map((response) => response.json())) as { replayed?: boolean }[];
    expect(concurrentBodies.filter((body) => body.replayed === false)).toHaveLength(1);
    expect(concurrentBodies.filter((body) => body.replayed === true)).toHaveLength(1);

    const complete = await completeUpload(
      new Request("http://localhost/api/v1/uploads/complete", { method: "POST", headers: auth(sessionId) }),
      { params: Promise.resolve({ uploadId: createdBody.uploadId }) },
    );
    expect(complete.status).toBe(200);

    await prisma.workspaceSubscription.create({
      data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" },
    });
    const queued = await enqueueJob(
      new Request("http://localhost/api/v1/meetings/process", {
        method: "POST",
        headers: auth(sessionId),
        body: JSON.stringify({ uploadId: createdBody.uploadId, idempotencyKey: `job-${meetingId}` }),
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(queued.status).toBe(202);
    const jobBody = (await queued.json()) as { jobId: string };

    const hiddenJob = await getJob(
      new Request("http://localhost/api/v1/jobs/job", { headers: auth(otherSessionId) }),
      { params: Promise.resolve({ jobId: jobBody.jobId }) },
    );
    expect(hiddenJob.status).toBe(404);
    const visibleJob = await getJob(
      new Request("http://localhost/api/v1/jobs/job", { headers: auth(sessionId) }),
      { params: Promise.resolve({ jobId: jobBody.jobId }) },
    );
    expect(visibleJob.status).toBe(200);
  });

  it("rejects writes to an expired upload and permits a same-key restart", async () => {
    const sessionId = await createPrincipal(USER_ID, "expired-upload@example.com", WORKSPACE_ID);
    const meetingId = randomUUID();
    await prisma.meeting.create({
      data: {
        id: meetingId,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        title: "Expired upload meeting",
        startedAt: new Date("2026-09-24T15:00:00.000Z"),
        endedAt: new Date("2026-09-24T15:30:00.000Z"),
        summary: "",
      },
    });
    const manifest = { meetingId, totalChunks: 1, totalBytes: 2, idempotencyKey: `expired-${meetingId}` };
    const created = await createUpload(new Request("http://localhost/api/v1/uploads", {
      method: "POST",
      headers: auth(sessionId),
      body: JSON.stringify(manifest),
    }));
    const uploadId = ((await created.json()) as { uploadId: string }).uploadId;
    await prisma.managedUpload.update({ where: { id: uploadId }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const bytes = new Uint8Array([9, 8]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const expiredChunk = await putChunk(new Request("http://localhost/api/v1/uploads/chunk", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionId}`, "x-audio-channel": "mic", "x-chunk-sha256": checksum },
      body: bytes,
    }), chunkContextFor(uploadId, 0));
    expect(expiredChunk.status).toBe(400);

    const restarted = await createUpload(new Request("http://localhost/api/v1/uploads", {
      method: "POST",
      headers: auth(sessionId),
      body: JSON.stringify(manifest),
    }));
    expect(restarted.status).toBe(201);
    expect(((await restarted.json()) as { uploadId: string }).uploadId).not.toBe(uploadId);
  });

  it("keeps Stripe checkout and portal actions owner-only", async () => {
    const memberSessionId = await createPrincipal(USER_ID, "route-member@example.com", WORKSPACE_ID, "member");
    const request = new Request("http://localhost/api/v1/billing/checkout", {
      method: "POST",
      headers: auth(memberSessionId),
      body: JSON.stringify({ priceId: "price-test", successUrl: "https://notes.example/success", cancelUrl: "https://notes.example/cancel" }),
    });
    expect((await checkout(request)).status).toBe(401);
    expect((await portal(new Request("http://localhost/api/v1/billing/portal", { method: "POST", headers: auth(memberSessionId) })))).toHaveProperty("status", 401);
  });

  it("accepts a signed Stripe webhook through the route and replays it idempotently", async () => {
    const secret = "whsec_route_test";
    const priceId = "price_route_hosted_pro";
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    process.env.STRIPE_PRICE_HOSTED_PRO = priceId;
    const eventId = `evt-route-webhook-${WORKSPACE_ID}`;
    const timestamp = Math.floor(Date.now() / 1_000);
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: timestamp,
      data: {
        object: {
          id: "sub_route_test",
          customer: "cus_route_test",
          status: "active",
          metadata: { workspaceId: WORKSPACE_ID },
          current_period_start: timestamp,
          current_period_end: timestamp + 30 * 24 * 60 * 60,
          items: { data: [{ price: { id: priceId } }] },
        },
      },
    });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const request = () => new Request("http://localhost/api/v1/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}`, "content-type": "application/json" },
      body: payload,
    });

    const first = await billingWebhook(request());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ received: true });
    const replay = await billingWebhook(request());
    expect(replay.status).toBe(200);
    await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: WORKSPACE_ID } })).resolves.toMatchObject({ plan: "hosted_pro", status: "active" });
    expect(await prisma.billingEvent.count({ where: { id: eventId } })).toBe(1);

    const invalid = await billingWebhook(new Request("http://localhost/api/v1/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=00`, "content-type": "application/json" },
      body: payload,
    }));
    expect(invalid.status).toBe(400);
  });
});

function chunkContextFor(uploadId: string, chunkIndex: number) {
  return { params: Promise.resolve({ uploadId, chunkIndex: String(chunkIndex) }) };
}
