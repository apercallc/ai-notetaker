import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";

vi.mock("./managedWorker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./managedWorker")>();
  return { ...actual, providerRequest: vi.fn() };
});

import { providerRequest } from "./managedWorker";
import { ChatBusyError, ChatProviderError, InvalidQuestionError, askNotes, retrieveNotes } from "./notesChat";
import { ChatUnavailableError, getChatEntitlement } from "./chatQuota";

let workspaceId = "";
let otherWorkspaceId = "";

async function meeting(ws: string, title: string, summary: string, startedAt: string, lines: string[] = []) {
  return prisma.meeting.create({
    data: {
      userId: "u",
      workspaceId: ws,
      title,
      summary,
      startedAt: new Date(startedAt),
      endedAt: new Date(startedAt),
      transcript: { create: lines.map((text, order) => ({ userId: "u", speaker: "them", text, timestamp: new Date(startedAt), order })) },
    },
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  workspaceId = randomUUID();
  otherWorkspaceId = randomUUID();
  process.env.MANAGED_SUMMARY_PROVIDER = "anthropic";
  process.env.MANAGED_ANTHROPIC_API_KEY = "test-key";
  await prisma.workspace.create({ data: { id: workspaceId, name: "Chat notes" } });
  await prisma.workspace.create({ data: { id: otherWorkspaceId, name: "Chat notes" } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { name: "Chat notes" } });
  await prisma.meeting.deleteMany({ where: { userId: "u", workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.$disconnect();
});

describe("retrieveNotes", () => {
  it("ranks meetings by term hits and includes matching transcript lines", async () => {
    await meeting(workspaceId, "Weekly sync", "General updates", "2026-09-20T10:00:00Z", ["Nothing here"]);
    await meeting(workspaceId, "Pricing review", "We settled the pricing tiers", "2026-09-10T10:00:00Z", ["Pricing goes up in October"]);
    const sources = await retrieveNotes(workspaceId, "What did we decide about pricing?");
    expect(sources.map((source) => source.title)).toEqual(["Pricing review"]);
    expect(sources[0]?.excerpts[0]?.text).toContain("October");
  });

  it("keeps a strongly matching old meeting even when many newer ones match weakly", async () => {
    await meeting(workspaceId, "Acme contract renewal", "acme contract terms and acme pricing", "2025-01-10T10:00:00Z", ["acme contract signed"]);
    for (let i = 0; i < 60; i += 1) {
      await meeting(workspaceId, `Standup ${i}`, "mentioned acme once", new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString());
    }
    const sources = await retrieveNotes(workspaceId, "acme contract pricing");
    expect(sources[0]?.title).toBe("Acme contract renewal");
  });

  it("never returns another workspace's notes", async () => {
    await meeting(otherWorkspaceId, "Secret pricing", "pricing secrets", "2026-09-10T10:00:00Z", ["pricing"]);
    expect(await retrieveNotes(workspaceId, "pricing")).toEqual([]);
  });

  it("falls back to recent meetings when the question has no usable terms", async () => {
    await meeting(workspaceId, "Older", "a", "2026-09-01T10:00:00Z");
    await meeting(workspaceId, "Newest", "b", "2026-09-25T10:00:00Z");
    const sources = await retrieveNotes(workspaceId, "What happened last week?");
    expect(sources.map((source) => source.title)).toEqual(["Newest", "Older"]);
  });
});

describe("askNotes", () => {
  async function subscribe(plan = "hosted_pro") {
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan, status: "active" } });
  }
  const reply = (text: string) => ({ json: async () => ({ content: [{ type: "text", text }] }) }) as Response;

  it("rejects empty and oversized questions before spending a question", async () => {
    await subscribe();
    await expect(askNotes(workspaceId, "   ")).rejects.toBeInstanceOf(InvalidQuestionError);
    await expect(askNotes(workspaceId, "x".repeat(501))).rejects.toBeInstanceOf(InvalidQuestionError);
    expect((await getChatEntitlement(workspaceId)).used).toBe(0);
  });

  it("refuses workspaces without a paid plan and makes no provider call", async () => {
    await expect(askNotes(workspaceId, "pricing?")).rejects.toBeInstanceOf(ChatUnavailableError);
    expect(providerRequest).not.toHaveBeenCalled();
  });

  it("answers with only the sources the model cited and counts one question", async () => {
    await subscribe();
    const first = await meeting(workspaceId, "Pricing review", "Tiers settled", "2026-09-10T10:00:00Z", ["pricing"]);
    await meeting(workspaceId, "Pricing follow-up", "More pricing", "2026-09-11T10:00:00Z");
    vi.mocked(providerRequest).mockResolvedValue(reply("Tiers were settled [1]. Not sure about [7]."));
    const result = await askNotes(workspaceId, "pricing tiers?");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ n: 1 });
    expect([first.id, result.sources[0]?.id]).toContain(result.sources[0]?.id);
    expect((await getChatEntitlement(workspaceId)).used).toBe(1);
    const body = JSON.parse(String(vi.mocked(providerRequest).mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toMatch(/<notes-[0-9a-f-]+>/);
  });

  it("limits simultaneous questions per workspace", async () => {
    await subscribe();
    const releases: (() => void)[] = [];
    vi.mocked(providerRequest).mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(reply("ok"))); }));
    const pending = [1, 2, 3].map(() => askNotes(workspaceId, "pricing?").catch((error) => error));
    await vi.waitFor(() => expect(providerRequest).toHaveBeenCalledTimes(3));
    await expect(askNotes(workspaceId, "pricing?")).rejects.toBeInstanceOf(ChatBusyError);
    releases.forEach((release) => release());
    await Promise.all(pending);
  });

  it("gives the question back when the provider fails", async () => {
    await subscribe();
    vi.mocked(providerRequest).mockRejectedValue(new (await import("./managedWorker")).ManagedWorkerError("boom"));
    await expect(askNotes(workspaceId, "pricing?")).rejects.toBeInstanceOf(ChatProviderError);
    expect((await getChatEntitlement(workspaceId)).used).toBe(0);
  });
});
