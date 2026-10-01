import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { ChatUnavailableError, getChatEntitlement, releaseChatQuestion, reserveChatQuestion } from "./chatQuota";
import { PLAN_CHAT_QUESTION_LIMITS } from "./plans";

let workspaceId = "";

async function setPlan(plan: string, status = "active") {
  await prisma.workspaceSubscription.upsert({
    where: { workspaceId },
    create: { workspaceId, plan, status },
    update: { plan, status },
  });
}

beforeEach(async () => {
  workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: "Chat quota" } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { name: "Chat quota" } });
  await prisma.$disconnect();
});

describe("chat quota", () => {
  it("is unavailable on local and trial plans", async () => {
    expect((await getChatEntitlement(workspaceId)).reason).toBe("plan");
    await setPlan("hosted_trial", "trialing");
    expect((await getChatEntitlement(workspaceId)).eligible).toBe(false);
    await expect(reserveChatQuestion(workspaceId)).rejects.toBeInstanceOf(ChatUnavailableError);
  });

  it("counts questions on paid plans and exhausts at the cap", async () => {
    await setPlan("hosted_pro");
    const limit = PLAN_CHAT_QUESTION_LIMITS.hosted_pro;
    expect(await getChatEntitlement(workspaceId)).toMatchObject({ eligible: true, used: 0, limit, remaining: limit });
    await reserveChatQuestion(workspaceId);
    expect((await getChatEntitlement(workspaceId)).used).toBe(1);

    await prisma.usageLedgerEntry.updateMany({ where: { workspaceId, kind: "notes_chat" }, data: { units: limit } });
    expect(await getChatEntitlement(workspaceId)).toMatchObject({ eligible: false, reason: "limit" });
    await expect(reserveChatQuestion(workspaceId)).rejects.toMatchObject({ reason: "limit" });
  });

  it("gives a question back when released", async () => {
    await setPlan("hosted_team");
    const key = await reserveChatQuestion(workspaceId);
    await releaseChatQuestion(workspaceId, key);
    expect((await getChatEntitlement(workspaceId)).used).toBe(0);
  });

  it("does not oversubscribe under concurrent questions", async () => {
    await setPlan("hosted_pro");
    const limit = PLAN_CHAT_QUESTION_LIMITS.hosted_pro;
    await prisma.usageLedgerEntry.create({
      data: { workspaceId, periodStart: new Date(), kind: "notes_chat", units: limit - 2, idempotencyKey: "seed" },
    });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => reserveChatQuestion(workspaceId)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect((await getChatEntitlement(workspaceId)).remaining).toBe(0);
  });

  it("does not touch meeting-processing usage", async () => {
    await setPlan("hosted_pro");
    await reserveChatQuestion(workspaceId);
    const rows = await prisma.usageLedgerEntry.findMany({ where: { workspaceId } });
    expect(rows.every((row) => row.kind === "notes_chat")).toBe(true);
  });
});
