import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import {
  MAX_DELIVERY_ATTEMPTS, MAX_INTEGRATIONS_PER_WORKSPACE, RETRY_DELAYS_MS,
  buildNotePayload, createIntegration, deleteIntegration, listIntegrations, notifyNoteReady, notionBlocks, parseNotionPageId,
  processDeliveries, rotateWebhookSecret, runIntegrationMaintenance, sendTestDelivery, setIntegrationEnabled, signWebhook, slackMessage,
  verifyWebhookSignature, type NewIntegration, type NotePayload, type Sender,
} from "./integrations";
import { upsertMeeting } from "./meetings";
import type { LibrarySession } from "./library";

const note = (overrides: Partial<NotePayload> = {}): NotePayload => ({
  id: "n1", title: "Acme <renewal> & plans", startedAt: "2026-09-30T15:00:00.000Z", endedAt: "2026-09-30T16:00:00.000Z", template: "sales", folder: null,
  url: "https://notes.example.com/meetings/n1", summaryMarkdown: "Acme wants to renew.\n\n## Next steps\n- Send the quote\n- Book a demo",
  actionItems: [{ text: "Send the quote", owner: "Sam", dueAt: null, status: "open" }, { text: "Already done", owner: null, dueAt: null, status: "done" }],
  ...overrides,
});

describe("webhook signing", () => {
  const body = '{"event":"note.ready"}';
  const now = 1_790_000_000_000;
  const timestamp = String(Math.floor(now / 1_000));

  it("verifies a genuine signature", () => {
    const signature = signWebhook("whsec_a", timestamp, body);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("whsec_a", timestamp, body, signature, 300, now)).toBe(true);
  });

  it("rejects a wrong secret, a changed body, a replayed old timestamp and garbage", () => {
    const signature = signWebhook("whsec_a", timestamp, body);
    expect(verifyWebhookSignature("whsec_b", timestamp, body, signature, 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_a", timestamp, `${body} `, signature, 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_a", timestamp, body, signature, 300, now + 10 * 60_000)).toBe(false);
    expect(verifyWebhookSignature("whsec_a", "abc", body, signature, 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_a", timestamp, body, "v1=short", 300, now)).toBe(false);
  });
});

describe("destination formatting", () => {
  it("extracts a Notion page id from links, dashed ids and bare ids", () => {
    const expected = "01234567-89ab-cdef-0123-456789abcdef";
    expect(parseNotionPageId("https://www.notion.so/My-Meeting-Notes-0123456789abcdef0123456789abcdef")).toBe(expected);
    expect(parseNotionPageId("https://www.notion.so/workspace/0123456789abcdef0123456789abcdef?pvs=4")).toBe(expected);
    expect(parseNotionPageId("01234567-89ab-cdef-0123-456789abcdef")).toBe(expected);
    expect(parseNotionPageId("0123456789ABCDEF0123456789ABCDEF")).toBe(expected);
    expect(parseNotionPageId("https://example.com/not-a-page")).toBeNull();
    expect(parseNotionPageId("")).toBeNull();
  });

  it("escapes Slack control characters, links the title, caps open actions at five and skips done ones", () => {
    const message = slackMessage(note({ actionItems: Array.from({ length: 8 }, (_, index) => ({ text: `Task <${index}>`, owner: null, dueAt: null, status: "open" })).concat([{ text: "Finished", owner: null, dueAt: null, status: "done" }]) }));
    const blocks = JSON.stringify(message.blocks);
    expect(message.text).toBe("Notes ready: Acme <renewal> & plans");
    expect(blocks).toContain("*<https://notes.example.com/meetings/n1|Acme &lt;renewal&gt; &amp; plans>*");
    expect(blocks).toContain("• Send the quote");
    expect(blocks).not.toContain("<0>");
    expect(blocks.match(/Task &lt;/g)).toHaveLength(5);
    expect(blocks).not.toContain("Finished");
  });

  it("keeps Slack text under its limits and works without a link", () => {
    const message = slackMessage(note({ url: null, title: "T".repeat(500), summaryMarkdown: "x".repeat(10_000), actionItems: [] }));
    const first = (message.blocks[0] as { text: { text: string } }).text.text;
    expect(first.length).toBeLessThanOrEqual(2_900);
    expect(first.startsWith("*" + "T".repeat(150))).toBe(true);
    expect(message.blocks).toHaveLength(1);
  });

  it("builds Notion blocks: link, headings, bullets, to-dos with checked state", () => {
    const blocks = notionBlocks(note()) as Array<{ type: string; to_do?: { checked: boolean } }>;
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "heading_2", "bulleted_list_item", "bulleted_list_item", "heading_2", "to_do", "to_do"]);
    expect(blocks.filter((block) => block.type === "to_do").map((block) => block.to_do!.checked)).toEqual([false, true]);
  });

  it("splits long Notion text at 2,000 characters and never exceeds 95 blocks", () => {
    const long = notionBlocks(note({ summaryMarkdown: "y".repeat(4_500), actionItems: [] })) as Array<{ paragraph?: { rich_text: Array<{ text: { content: string } }> } }>;
    const lengths = long[1]!.paragraph!.rich_text.map((part) => part.text.content.length);
    expect(lengths).toEqual([2_000, 2_000, 500]);
    const many = notionBlocks(note({ summaryMarkdown: Array.from({ length: 200 }, (_, index) => `- item ${index}`).join("\n"), actionItems: [] }));
    expect(many.length).toBeLessThanOrEqual(95);
  });
});

describe("integrations", () => {
  const saved: Record<string, string | undefined> = {};
  let workspaceId: string;
  let otherWorkspaceId: string;
  let owner: LibrarySession;
  let member: LibrarySession;

  const webhookInput = { kind: "webhook" as const, name: "Zapier", url: "https://hooks.zapier.com/hooks/catch/123/abc/" };
  const slackUrl = "https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx";

  async function meeting(options: { summary?: string; title?: string; folderId?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await prisma.meeting.create({ data: { id, userId: owner.userId, workspaceId, title: options.title ?? "Quarterly call", summary: options.summary ?? "A summary.", startedAt: new Date("2026-09-30T15:00:00Z"), endedAt: new Date("2026-09-30T16:00:00Z"), folderId: options.folderId ?? null } });
    return id;
  }

  const created = async (input: NewIntegration = webhookInput) => {
    const result = await createIntegration(owner, input);
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  beforeEach(async () => {
    for (const name of ["APP_URL", "AUTH_TOKEN", "INTEGRATIONS_ALLOW_PRIVATE_NETWORKS", "INTEGRATIONS_ENCRYPTION_KEY"]) saved[name] = process.env[name];
    process.env.AUTH_TOKEN = "integration-test-token";
    process.env.APP_URL = "https://notes.example.com";
    delete process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS;
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await prisma.workspace.createMany({ data: [{ id: workspaceId, name: "Integrations workspace" }, { id: otherWorkspaceId, name: "Other integrations workspace" }] });
    owner = { workspaceId, userId: "integ-owner", role: "owner" };
    member = { workspaceId, userId: "integ-member", role: "member" };
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("managing", () => {
    it("creates a webhook, shows its signing secret once, stores only ciphertext and audits without secrets", async () => {
      const result = await created();
      expect(result.secret).toMatch(/^whsec_/);
      const row = await prisma.integration.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.configCipher).not.toContain(result.secret!);
      expect(row.configCipher).not.toContain("hooks.zapier.com");
      const [view] = await listIntegrations(workspaceId);
      expect(view).toMatchObject({ id: result.id, kind: "webhook", name: "Zapier", enabled: true, hint: "hooks.zapier.com" });
      expect(JSON.stringify(view)).not.toContain(result.secret!);
      const events = await prisma.auditEvent.findMany({ where: { workspaceId } });
      expect(events.map((event) => event.action)).toEqual(["integration.create"]);
      expect(JSON.stringify(events)).not.toContain(result.secret!);
      expect(JSON.stringify(events)).not.toContain("hooks.zapier.com");
    });

    it("creates Slack and Notion integrations without a signing secret", async () => {
      const slack = await created({ kind: "slack", name: "Team channel", slackWebhookUrl: slackUrl });
      const notion = await created({ kind: "notion", name: "Notes page", notionToken: "ntn_" + "a".repeat(30), notionPage: "https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef" });
      expect(slack.secret).toBeUndefined();
      expect(notion.secret).toBeUndefined();
      const hints = (await listIntegrations(workspaceId)).map((view) => view.hint);
      expect(hints).toEqual(["Slack incoming webhook", "Notion page …cdef"]);
    });

    it("is for owners only", async () => {
      expect(await createIntegration(member, webhookInput)).toEqual({ ok: false, error: "Only a workspace owner can manage integrations." });
      const { id } = await created();
      expect(await setIntegrationEnabled(member, id, false)).toMatchObject({ ok: false });
      expect(await deleteIntegration(member, id)).toMatchObject({ ok: false });
      expect(await rotateWebhookSecret(member, id)).toMatchObject({ ok: false });
      expect(await sendTestDelivery(member, id, vi.fn())).toMatchObject({ ok: false });
    });

    it("rejects private, insecure and malformed destinations and bad credentials", async () => {
      for (const url of ["https://127.0.0.1/hook", "http://example.com/hook", "https://localhost/x", "https://169.254.169.254/x", "not a url", ""]) {
        expect(await createIntegration(owner, { ...webhookInput, url }), url).toMatchObject({ ok: false });
      }
      expect(await createIntegration(owner, { kind: "slack", name: "S", slackWebhookUrl: "https://evil.example.com/services/T/B/x" })).toMatchObject({ ok: false });
      expect(await createIntegration(owner, { kind: "notion", name: "N", notionToken: "short", notionPage: "0123456789abcdef0123456789abcdef" })).toMatchObject({ ok: false });
      expect(await createIntegration(owner, { kind: "notion", name: "N", notionToken: "t".repeat(30), notionPage: "not a page" })).toMatchObject({ ok: false });
      expect(await createIntegration(owner, { ...webhookInput, name: "  " })).toMatchObject({ ok: false });
      expect(await createIntegration(owner, { ...webhookInput, name: "x".repeat(61) })).toMatchObject({ ok: false });
      expect(await createIntegration(owner, { ...webhookInput, kind: "ftp" as never })).toMatchObject({ ok: false });
      expect(await prisma.integration.count({ where: { workspaceId } })).toBe(0);
    });

    it("lets an operator opt in to a private network target", async () => {
      process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS = "true";
      expect((await createIntegration(owner, { ...webhookInput, url: "http://192.168.1.20:5678/webhook" })).ok).toBe(true);
    });

    it("caps the number per workspace", async () => {
      for (let index = 0; index < MAX_INTEGRATIONS_PER_WORKSPACE; index += 1) await created({ ...webhookInput, name: `Hook ${index}` });
      expect(await createIntegration(owner, webhookInput)).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_INTEGRATIONS_PER_WORKSPACE)) });
    });

    it("toggles, deletes, and stays inside the workspace", async () => {
      const { id } = await created();
      expect(await setIntegrationEnabled(owner, id, false)).toEqual({ ok: true });
      expect((await listIntegrations(workspaceId))[0]!.enabled).toBe(false);
      expect(await setIntegrationEnabled({ ...owner, workspaceId: otherWorkspaceId }, id, true)).toMatchObject({ ok: false });
      expect(await deleteIntegration({ ...owner, workspaceId: otherWorkspaceId }, id)).toMatchObject({ ok: false });
      expect(await deleteIntegration(owner, id)).toEqual({ ok: true });
      expect(await listIntegrations(workspaceId)).toEqual([]);
    });

    it("rotates a webhook secret: the sender sees the new one", async () => {
      const { id, secret } = await created();
      const rotated = await rotateWebhookSecret(owner, id);
      if (!rotated.ok) throw new Error(rotated.error);
      expect(rotated.secret).not.toBe(secret);
      let seen = "";
      const send: Sender = async (_kind, config) => { seen = (config as { secret: string }).secret; return { ok: true, status: 200 }; };
      expect(await sendTestDelivery(owner, id, send)).toEqual({ ok: true, message: "Test delivered." });
      expect(seen).toBe(rotated.secret);
      expect(await rotateWebhookSecret(owner, (await created({ kind: "slack", name: "S", slackWebhookUrl: slackUrl })).id)).toMatchObject({ ok: false });
    });

    it("reports unreadable credentials instead of failing silently", async () => {
      const { id } = await created();
      process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64"); // a different key than the one used to save
      expect((await listIntegrations(workspaceId))[0]!.hint).toBe("Needs to be re-entered");
      expect(await sendTestDelivery(owner, id, vi.fn())).toMatchObject({ ok: false, error: expect.stringContaining("Re-create") });
    });
  });

  describe("note payload", () => {
    it("applies speaker names, includes the folder path and link, and adds the transcript only on request", async () => {
      const parent = await prisma.folder.create({ data: { workspaceId, name: "Clients" } });
      const child = await prisma.folder.create({ data: { workspaceId, name: "Acme", parentId: parent.id } });
      const id = await meeting({ folderId: child.id, summary: "## Key points\n- renewal" });
      await prisma.transcriptSegment.createMany({ data: [
        { meetingId: id, userId: "u", speaker: "them-1", text: "We need faster onboarding.", timestamp: new Date("2026-09-30T15:01:00Z"), order: 0 },
        { meetingId: id, userId: "u", speaker: "you", text: "Understood.", timestamp: new Date("2026-09-30T15:02:00Z"), order: 1 },
      ] });
      await prisma.meetingSpeaker.create({ data: { meetingId: id, speakerKey: "them-1", displayName: "Sam Rivera", appliedLabel: "Sam Rivera" } });
      await prisma.actionItem.create({ data: { meetingId: id, userId: "u", text: "Send quote", owner: "Sam Rivera" } });

      const without = (await buildNotePayload(workspaceId, id, false))!;
      expect(without).toMatchObject({ id, title: "Quarterly call", folder: "Clients / Acme", url: `https://notes.example.com/meetings/${id}`, summaryMarkdown: "## Key points\n- renewal" });
      expect(without.actionItems).toEqual([{ text: "Send quote", owner: "Sam Rivera", dueAt: null, status: "open" }]);
      expect(without).not.toHaveProperty("transcript");

      const withTranscript = (await buildNotePayload(workspaceId, id, true))!;
      expect(withTranscript.transcript!.map((line) => [line.speaker, line.text])).toEqual([["Sam Rivera", "We need faster onboarding."], ["You", "Understood."]]);
      expect(JSON.stringify(withTranscript)).not.toMatch(/userId|workspaceId|processingMode|configCipher/);
    });

    it("returns nothing for a trashed, missing or foreign note", async () => {
      const id = await meeting();
      expect(await buildNotePayload(otherWorkspaceId, id, false)).toBeNull();
      expect(await buildNotePayload(workspaceId, randomUUID(), false)).toBeNull();
      await prisma.meeting.update({ where: { id }, data: { deletedAt: new Date() } });
      expect(await buildNotePayload(workspaceId, id, false)).toBeNull();
    });
  });

  describe("delivery", () => {
    const ok: Sender = async () => ({ ok: true, status: 200 });

    it("announces a note once, to enabled integrations only, and delivers it", async () => {
      const a = await created();
      const b = await created({ ...webhookInput, name: "Off" });
      await setIntegrationEnabled(owner, b.id, false);
      const id = await meeting();
      const calls: Array<{ kind: string; event: string; deliveryId: string; title: string }> = [];
      const send: Sender = async (kind, _config, event, deliveryId, payload) => { calls.push({ kind, event, deliveryId, title: payload.title }); return { ok: true, status: 200 }; };

      expect(await notifyNoteReady(workspaceId, id, send)).toBe(1);
      await vi.waitFor(async () => expect((await prisma.integrationDelivery.findMany({ where: { workspaceId } })).map((d) => d.status)).toEqual(["delivered"]));
      expect(calls).toEqual([{ kind: "webhook", event: "note.ready", deliveryId: expect.any(String), title: "Quarterly call" }]);
      expect(await notifyNoteReady(workspaceId, id, send)).toBe(0); // second announcement does nothing
      expect(await prisma.integrationDelivery.count({ where: { workspaceId } })).toBe(1);
      expect((await prisma.integration.findUniqueOrThrow({ where: { id: a.id } }))).toMatchObject({ lastStatus: "ok", lastError: null });
      expect((await prisma.integration.findUniqueOrThrow({ where: { id: a.id } })).lastDeliveredAt).not.toBeNull();
    });

    it("does nothing without integrations or for a trashed note, and leaves the note announceable later", async () => {
      const id = await meeting();
      expect(await notifyNoteReady(workspaceId, id, ok)).toBe(0);
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id } })).readyNotifiedAt).toBeNull();
      await created();
      await prisma.meeting.update({ where: { id }, data: { deletedAt: new Date() } });
      expect(await notifyNoteReady(workspaceId, id, ok)).toBe(0);
    });

    async function pendingDelivery() {
      const { id: integrationId } = await created();
      const meetingId = await meeting();
      return prisma.integrationDelivery.create({ data: { integrationId, workspaceId, event: "note.ready", meetingId } });
    }

    it("retries a failure on the backoff schedule and gives up after the last attempt", async () => {
      const delivery = await pendingDelivery();
      const failing: Sender = async () => ({ ok: false, status: 500, error: "The destination answered HTTP 500." });
      let now = new Date();
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        const tally = await processDeliveries({ now, send: failing });
        const row = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
        expect(row.attempts).toBe(attempt);
        if (attempt < MAX_DELIVERY_ATTEMPTS) {
          expect(tally).toMatchObject({ retried: 1, failed: 0 });
          expect(row).toMatchObject({ status: "pending", lastError: "The destination answered HTTP 500.", responseStatus: 500 });
          expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[attempt - 1]!);
          // Not due before its time: nothing is sent.
          const early = vi.fn(failing);
          await processDeliveries({ now: new Date(now.getTime() + RETRY_DELAYS_MS[attempt - 1]! - 1_000), send: early });
          expect(early).not.toHaveBeenCalled();
          now = new Date(now.getTime() + RETRY_DELAYS_MS[attempt - 1]! + 1);
        } else {
          expect(tally).toMatchObject({ failed: 1 });
          expect(row.status).toBe("failed");
        }
      }
      const integration = await prisma.integration.findFirstOrThrow({ where: { workspaceId } });
      expect(integration).toMatchObject({ lastStatus: "failed", lastError: "The destination answered HTTP 500." });
    });

    it("recovers when a later attempt succeeds", async () => {
      const delivery = await pendingDelivery();
      await processDeliveries({ send: async () => ({ ok: false, status: null, error: "The request timed out." }) });
      const later = new Date(Date.now() + 2 * 60_000);
      expect(await processDeliveries({ now: later, send: ok })).toMatchObject({ delivered: 1 });
      expect(await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: "delivered", attempts: 2, lastError: null });
    });

    it("treats a thrown sender as a failed attempt", async () => {
      await pendingDelivery();
      expect(await processDeliveries({ send: async () => { throw new Error("boom with secret details"); } })).toMatchObject({ retried: 1 });
      expect((await prisma.integrationDelivery.findFirstOrThrow({ where: { workspaceId } })).lastError).toBe("The request failed.");
    });

    it("skips deliveries whose note was deleted or whose integration was turned off", async () => {
      const gone = await pendingDelivery();
      await prisma.meeting.update({ where: { id: gone.meetingId! }, data: { deletedAt: new Date() } });
      const off = await pendingDelivery();
      await prisma.integration.update({ where: { id: off.integrationId }, data: { enabled: false } });
      const send = vi.fn(ok);
      expect(await processDeliveries({ send })).toMatchObject({ skipped: 2, delivered: 0 });
      expect(send).not.toHaveBeenCalled();
      expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: gone.id } })).status).toBe("skipped");
    });

    it("never double-sends when two workers run at once", async () => {
      await pendingDelivery();
      let calls = 0;
      const slow: Sender = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 150)); return { ok: true, status: 200 }; };
      await Promise.all([processDeliveries({ send: slow }), processDeliveries({ send: slow })]);
      expect(calls).toBe(1);
    });

    it("sends the test event with a synthetic note and records the outcome", async () => {
      const { id } = await created();
      const seen: string[] = [];
      expect(await sendTestDelivery(owner, id, async (_k, _c, event, _d, payload) => { seen.push(`${event}:${payload.id}`); return { ok: true, status: 200 }; })).toEqual({ ok: true, message: "Test delivered." });
      expect(seen).toEqual(["test:test-note"]);
      expect(await sendTestDelivery(owner, id, async () => ({ ok: false, status: 404, error: "The destination wasn't found (HTTP 404). Check the URL." }))).toEqual({ ok: false, error: "The destination wasn't found (HTTP 404). Check the URL." });
      expect(await prisma.integration.findUniqueOrThrow({ where: { id } })).toMatchObject({ lastStatus: "failed" });
      expect(await sendTestDelivery(owner, randomUUID(), ok)).toMatchObject({ ok: false });
      const audits = await prisma.auditEvent.findMany({ where: { workspaceId, action: "integration.test" } });
      expect(audits.map((event) => event.metadata)).toEqual([{ ok: true }, { ok: false }]);
    });

    it("prunes deliveries older than two weeks", async () => {
      const delivery = await pendingDelivery();
      await prisma.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "delivered", createdAt: new Date(Date.now() - 15 * 24 * 3_600_000) } });
      const recent = await pendingDelivery();
      await runIntegrationMaintenance(new Date(), true);
      expect(await prisma.integrationDelivery.count({ where: { id: delivery.id } })).toBe(0);
      expect(await prisma.integrationDelivery.count({ where: { id: recent.id } })).toBe(1);
    });
  });

  describe("real webhook delivery", () => {
    it("posts signed JSON to the receiver that a customer can verify with the documented recipe", async () => {
      const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
          response.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS = "true";
        const { id, secret } = await created({ ...webhookInput, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` });
        expect(await sendTestDelivery(owner, id)).toEqual({ ok: true, message: "Test delivered." });

        const request = received[0]!;
        expect(request.headers["content-type"]).toBe("application/json");
        expect(request.headers["x-notetaker-event"]).toBe("test");
        expect(request.headers["user-agent"]).toBe("AI-Notetaker-Webhooks/1");
        expect(verifyWebhookSignature(secret!, String(request.headers["x-notetaker-timestamp"]), request.body, String(request.headers["x-notetaker-signature"]))).toBe(true);
        expect(verifyWebhookSignature("whsec_wrong", String(request.headers["x-notetaker-timestamp"]), request.body, String(request.headers["x-notetaker-signature"]))).toBe(false);
        const parsed = JSON.parse(request.body) as { id: string; event: string; note: { title: string } };
        expect(parsed).toMatchObject({ event: "test", note: { title: "Test note from AI Notetaker" } });
        expect(parsed.id).toBe(request.headers["x-notetaker-delivery"]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("reports a non-2xx answer and a blocked address in words, without leaking internals", async () => {
      const server = http.createServer((_request, response) => response.writeHead(401).end("nope"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS = "true";
        const { id } = await created({ ...webhookInput, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` });
        expect(await sendTestDelivery(owner, id)).toEqual({ ok: false, error: "The destination rejected the credentials (HTTP 401)." });
        // Without the operator opt-in the same saved target is refused at send time.
        delete process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS;
        const blocked = await sendTestDelivery(owner, id);
        expect(blocked).toMatchObject({ ok: false });
        expect((blocked as { error: string }).error).toMatch(/private network|Use an https/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("hooks", () => {
    const input = (id: string, summary: string, processingMode?: string) => ({
      id, startedAt: "2026-09-30T15:00:00.000Z", endedAt: "2026-09-30T16:00:00.000Z", summary, transcript: [], actionItems: [], ...(processingMode ? { processingMode } : {}),
    });

    it("announces a synced note that arrives with a summary, once, and not an empty or hosted-registration shell", async () => {
      await created();
      const registered = randomUUID();
      await upsertMeeting(input(registered, "", "managed"), workspaceId, "u");
      await upsertMeeting(input(randomUUID(), "", undefined), workspaceId, "u");
      const finished = randomUUID();
      await upsertMeeting(input(finished, "Real notes."), workspaceId, "u");
      await upsertMeeting(input(finished, "Real notes, edited."), workspaceId, "u");
      await vi.waitFor(async () => expect(await prisma.integrationDelivery.count({ where: { workspaceId } })).toBe(1));
      expect((await prisma.integrationDelivery.findFirstOrThrow({ where: { workspaceId } })).meetingId).toBe(finished);
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id: registered } })).readyNotifiedAt).toBeNull();
    });
  });
});
