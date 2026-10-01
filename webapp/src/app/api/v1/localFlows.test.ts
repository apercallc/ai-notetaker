/**
 * Local end-to-end checks for the manual acceptance list, run against real
 * Postgres and the real route handlers with an in-memory fake of Google
 * (OAuth, Drive) and Stripe. They prove our side of each flow
 * without live accounts; they cannot prove Google's or Stripe's own behaviour.
 */
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkout } from "./billing/checkout/route";
import { POST as billingWebhook } from "./billing/webhook/route";
import { POST as exportGoogleDrive } from "./google/drive/export/route";
import { POST as createUpload } from "./uploads/route";
import { GET as getEntitlements } from "./entitlements/route";
import { prisma } from "@/lib/db";
import { completeOAuthConnection, disconnectGoogle } from "@/lib/googleIntegration";
import { reserveMeetingProcessing } from "@/lib/usageLedger";

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const MEETING_ID = randomUUID();
const PRO_PRICE = "price_local_flow_pro";
const WEBHOOK_SECRET = "whsec_local_flow";
const env = { ...process.env };

// ---------------------------------------------------------------- fakes

interface DriveFile { id: string; name: string; mimeType: string; parents: string[]; text?: string }

function makeFakeGoogle() {
  const files: DriveFile[] = [];
  const calls: string[] = [];
  let revoked: string | null = null;
  let nextId = 1;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      return json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600, scope: "openid email drive.file" });
    }
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/revoke") {
      revoked = new URLSearchParams(String(init?.body)).get("token");
      return json({});
    }
    if (url.pathname === "/oauth2/v3/userinfo") return json({ email: "person@example.test", email_verified: true });
    if (url.pathname === "/drive/v3/files" && (init?.method ?? "GET") === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const found = files.filter((file) => file.mimeType === "application/vnd.google-apps.folder" && q.includes(`name = '${file.name}'`));
      return json({ files: found.map((file) => ({ id: file.id })) });
    }
    if (url.pathname === "/drive/v3/files" && init?.method === "POST") {
      const meta = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents: string[] };
      const file = { id: `folder-${nextId++}`, ...meta };
      files.push(file);
      return json({ id: file.id });
    }
    if (url.pathname === "/upload/drive/v3/files") {
      const body = String(init?.body);
      const boundary = /boundary=(.+)$/.exec(String((init?.headers as Record<string, string>)["Content-Type"]))?.[1] ?? "";
      const parts = body.split(`--${boundary}`).filter((part) => part.includes("Content-Type"));
      const meta = JSON.parse(parts[0]!.split("\r\n\r\n")[1]!.trim()) as { name: string; mimeType: string; parents: string[] };
      const text = parts[1]!.split("\r\n\r\n")[1]!.replace(/\r\n$/, "");
      const file = { id: `doc-${nextId++}`, ...meta, text };
      files.push(file);
      return json({ id: file.id, webViewLink: `https://docs.google.com/document/d/${file.id}/edit` });
    }
    return json({ error: "unexpected fake Google call" }, 500);
  }
  return { handle, files, calls, revokedToken: () => revoked };
}

// ---------------------------------------------------------------- helpers

function bearer(sessionId: string): HeadersInit {
  return { authorization: `Bearer ${sessionId}`, "content-type": "application/json" };
}

async function seedWorkspace(): Promise<string> {
  await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Local flows workspace" } });
  await prisma.user.create({ data: { id: USER_ID, email: `local-flows-${USER_ID}@example.test`, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.workspaceMembership.create({ data: { userId: USER_ID, workspaceId: WORKSPACE_ID, role: "owner" } });
  const session = await prisma.session.create({ data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) } });
  return session.id;
}

function signedWebhook(event: Record<string, unknown>): Request {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return new Request("http://localhost/api/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}`, "content-type": "application/json" },
    body: payload,
  });
}

function subscriptionEvent(type: string, id: string, subscription: string, status: string): Record<string, unknown> {
  return {
    id,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: subscription, customer: "cus_local_flow", status, metadata: { workspaceId: WORKSPACE_ID }, items: { data: [{ price: { id: PRO_PRICE } }] } } },
  };
}

let sessionId: string;
let google: ReturnType<typeof makeFakeGoogle>;

beforeEach(async () => {
  process.env.MANAGED_HOSTING = "true";
  process.env.APP_URL = "https://notes.example.test";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.STRIPE_SECRET_KEY = "sk_local_flow";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_HOSTED_PRO = PRO_PRICE;
  google = makeFakeGoogle();
  vi.stubGlobal("fetch", vi.fn(google.handle));
  sessionId = await seedWorkspace();
});

afterEach(async () => {
  await prisma.meeting.deleteMany({ where: { id: MEETING_ID } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.billingEvent.deleteMany({ where: { id: { startsWith: "evt-local-flow-" } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  vi.unstubAllGlobals();
  Object.assign(process.env, env);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function connectGoogle(): Promise<void> {
  await completeOAuthConnection(USER_ID, "auth-code", { userId: USER_ID, state: "s", verifier: "v", expiresAt: Date.now() + 60_000, purpose: "connect" });
}

async function seedFinishedMeeting(): Promise<void> {
  await prisma.meeting.create({
    data: {
      id: MEETING_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      title: "Quarterly planning",
      startedAt: new Date("2026-09-30T15:00:00.000Z"),
      endedAt: new Date("2026-09-30T15:30:00.000Z"),
      summary: "We agreed to ship the launch on Friday.",
    },
  });
  await prisma.transcriptSegment.create({ data: { meetingId: MEETING_ID, userId: USER_ID, speaker: "you", text: "Let's ship on Friday.", timestamp: new Date("2026-09-30T15:01:00.000Z"), order: 0 } });
  await prisma.actionItem.create({ data: { meetingId: MEETING_ID, userId: USER_ID, text: "Send the launch email", owner: "Sam", status: "open" } });
}

// ------------------------------------------------------------------ flows

describe("acceptance: Google Drive export, disconnect and reconnect", () => {
  it("exports a finished meeting to a Google Doc in an ai-notetaker folder, reusing the folder next time", async () => {
    await connectGoogle();
    await seedFinishedMeeting();
    const exportOnce = () => exportGoogleDrive(new Request("http://localhost/api/v1/google/drive/export", { method: "POST", headers: bearer(sessionId), body: JSON.stringify({ meetingId: MEETING_ID }) }));

    const first = await exportOnce();
    expect(first.status).toBe(201);
    const { fileId, webViewLink } = (await first.json()) as { fileId: string; webViewLink: string };
    expect(webViewLink).toContain(fileId);

    const folder = google.files.find((file) => file.mimeType === "application/vnd.google-apps.folder");
    expect(folder).toMatchObject({ name: "ai-notetaker", parents: ["root"] });
    const doc = google.files.find((file) => file.id === fileId)!;
    expect(doc.mimeType).toBe("application/vnd.google-apps.document");
    expect(doc.parents).toEqual([folder!.id]);
    expect(doc.name).toBe("Quarterly planning — 2026-09-30");
    // The Doc is created from text that carries every part of the notes.
    expect(doc.text).toContain("We agreed to ship the launch on Friday.");
    expect(doc.text).toContain("Send the launch email (Sam)");
    expect(doc.text).toContain("You: Let's ship on Friday.");

    await exportOnce();
    expect(google.files.filter((file) => file.mimeType === "application/vnd.google-apps.folder")).toHaveLength(1);
  });

  it("refuses to export another workspace's meeting", async () => {
    await connectGoogle();
    const response = await exportGoogleDrive(new Request("http://localhost/api/v1/google/drive/export", { method: "POST", headers: bearer(sessionId), body: JSON.stringify({ meetingId: randomUUID() }) }));
    expect(response.status).toBe(404);
    expect(google.files).toHaveLength(0);
  });

  it("disconnect revokes at Google and afterwards the features ask to reconnect", async () => {
    await connectGoogle();
    await seedFinishedMeeting();
    await disconnectGoogle(USER_ID);
    expect(google.revokedToken()).toBe("fake-refresh");
    const response = await exportGoogleDrive(new Request("http://localhost/api/v1/google/drive/export", { method: "POST", headers: bearer(sessionId), body: JSON.stringify({ meetingId: MEETING_ID }) }));
    expect(response.status).toBe(409);
    // Reconnecting works again.
    await connectGoogle();
    const again = await exportGoogleDrive(new Request("http://localhost/api/v1/google/drive/export", { method: "POST", headers: bearer(sessionId), body: JSON.stringify({ meetingId: MEETING_ID }) }));
    expect(again.status).toBe(201);
  });
});

describe("acceptance: paid checkout, cancel and resubscribe", () => {
  function stubStripeCheckout() {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/checkout/sessions")) return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }));
  }
  const startCheckout = () => checkout(new Request("http://localhost/api/v1/billing/checkout", {
    method: "POST",
    headers: bearer(sessionId),
    body: JSON.stringify({ priceId: PRO_PRICE, successUrl: "https://notes.example.test/billing?ok=1", cancelUrl: "https://notes.example.test/billing" }),
  }));
  const entitlements = async () => (await (await getEntitlements(new Request("http://localhost/api/v1/entitlements", { headers: bearer(sessionId) }))).json()) as { plan: string; canProcess: boolean; remaining: number };

  it("lets a trial workspace buy Pro, cancel, and resubscribe with access each time", async () => {
    await prisma.workspaceSubscription.create({ data: { workspaceId: WORKSPACE_ID, plan: "hosted_trial", status: "trialing" } });
    expect(await entitlements()).toMatchObject({ plan: "hosted_trial", canProcess: true, remaining: 3 });
    stubStripeCheckout();

    const started = await startCheckout();
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    // Starting checkout must not spend or hide the free meetings.
    expect(await entitlements()).toMatchObject({ plan: "hosted_trial", canProcess: true, remaining: 3 });

    expect((await billingWebhook(signedWebhook(subscriptionEvent("customer.subscription.created", "evt-local-flow-1", "sub_first", "active")))).status).toBe(200);
    expect(await entitlements()).toMatchObject({ plan: "hosted_pro", canProcess: true });

    // A second checkout while subscribed is routed to the billing portal.
    expect((await startCheckout()).status).toBe(409);

    expect((await billingWebhook(signedWebhook(subscriptionEvent("customer.subscription.deleted", "evt-local-flow-2", "sub_first", "canceled")))).status).toBe(200);
    expect(await entitlements()).toMatchObject({ canProcess: false });

    expect((await startCheckout()).status).toBe(200);
    expect((await billingWebhook(signedWebhook(subscriptionEvent("customer.subscription.created", "evt-local-flow-3", "sub_second", "active")))).status).toBe(200);
    expect(await entitlements()).toMatchObject({ plan: "hosted_pro", canProcess: true });
    const row = await prisma.workspaceSubscription.findUniqueOrThrow({ where: { workspaceId: WORKSPACE_ID } });
    expect(row).toMatchObject({ stripeSubscriptionId: "sub_second", status: "active", checkoutClaimedAt: null });
  });

  it("rejects an unsigned webhook so nobody can grant themselves a plan", async () => {
    const forged = new Request("http://localhost/api/v1/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=00", "content-type": "application/json" },
      body: JSON.stringify(subscriptionEvent("customer.subscription.created", "evt-local-flow-forged", "sub_x", "active")),
    });
    expect((await billingWebhook(forged)).status).toBe(400);
    expect(await prisma.workspaceSubscription.findUnique({ where: { workspaceId: WORKSPACE_ID } })).toBeNull();
  });

  it("returns an upgrade prompt (402) instead of an error once the free meetings are used", async () => {
    await prisma.workspaceSubscription.create({ data: { workspaceId: WORKSPACE_ID, plan: "hosted_trial", status: "trialing" } });
    for (let index = 0; index < 3; index += 1) await reserveMeetingProcessing(WORKSPACE_ID, `used-${index}`);
    await prisma.meeting.create({ data: { id: MEETING_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, title: "Fourth", startedAt: new Date(), endedAt: new Date(), summary: "" } });
    const response = await createUpload(new Request("http://localhost/api/v1/uploads", {
      method: "POST",
      headers: bearer(sessionId),
      body: JSON.stringify({ meetingId: MEETING_ID, totalChunks: 1, totalBytes: 1, idempotencyKey: `fourth-${MEETING_ID}` }),
    }));
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "entitlement_unavailable" });
  });
});
