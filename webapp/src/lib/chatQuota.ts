import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { hostedAiEnabled } from "./deploymentConfig";
import { PLAN_CHAT_QUESTION_LIMITS, isManagedPlan } from "./plans";
import { hasProcessingAccess, isSerializationConflict, usageWindow } from "./usageLedger";

const CHAT_KIND = "notes_chat";
const RESERVATION_ATTEMPTS = 8;

export class ChatUnavailableError extends Error {
  constructor(readonly reason: "plan" | "limit") {
    super(reason === "plan" ? "Ask your notes is not available on your plan." : "You have used every question included in this period.");
    this.name = "ChatUnavailableError";
  }
}

function questionLimit(plan: string): number {
  return isManagedPlan(plan) ? PLAN_CHAT_QUESTION_LIMITS[plan] : 0;
}

export interface ChatEntitlement {
  eligible: boolean;
  used: number;
  limit: number;
  remaining: number;
  /** Why chat is unavailable, when it is. */
  reason: "plan" | "limit" | null;
}

export async function getChatEntitlement(workspaceId: string): Promise<ChatEntitlement> {
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  const limit = questionLimit(subscription?.plan ?? "local");
  const planOk = limit > 0 && hasProcessingAccess(subscription);
  if (!planOk) return { eligible: false, used: 0, limit, remaining: 0, reason: "plan" };
  const window = usageWindow(subscription);
  const aggregate = await prisma.usageLedgerEntry.aggregate({
    where: { workspaceId, kind: CHAT_KIND, units: { gt: 0 }, periodStart: { gte: window.start, ...(window.end ? { lt: window.end } : {}) } },
    _sum: { units: true },
  });
  const used = aggregate._sum.units ?? 0;
  const remaining = Math.max(0, limit - used);
  return { eligible: remaining > 0, used, limit, remaining, reason: remaining > 0 ? null : "limit" };
}

/**
 * Atomically counts one question against the plan. The check and the insert
 * share a serializable transaction so concurrent questions cannot oversubscribe
 * the cap. Returns the key to release if the provider call fails.
 */
export async function reserveChatQuestion(workspaceId: string): Promise<string> {
  if (!hostedAiEnabled()) throw new ChatUnavailableError("plan");
  const idempotencyKey = `chat:${randomUUID()}`;
  for (let attempt = 0; attempt < RESERVATION_ATTEMPTS; attempt += 1) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const subscription = await tx.workspaceSubscription.findUnique({ where: { workspaceId } });
          const limit = questionLimit(subscription?.plan ?? "local");
          if (limit <= 0 || !hasProcessingAccess(subscription)) throw new ChatUnavailableError("plan");
          const window = usageWindow(subscription);
          const used = await tx.usageLedgerEntry.aggregate({
            where: { workspaceId, kind: CHAT_KIND, units: { gt: 0 }, periodStart: { gte: window.start, ...(window.end ? { lt: window.end } : {}) } },
            _sum: { units: true },
          });
          if ((used._sum.units ?? 0) >= limit) throw new ChatUnavailableError("limit");
          await tx.usageLedgerEntry.create({
            data: { workspaceId, periodStart: window.entryPeriodStart, kind: CHAT_KIND, units: 1, audioSeconds: 0, idempotencyKey },
          });
        },
        { isolationLevel: "Serializable" },
      );
      return idempotencyKey;
    } catch (error) {
      if (isSerializationConflict(error) && attempt < RESERVATION_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1) + Math.random() * 20));
        continue;
      }
      throw error;
    }
  }
  throw new Error("chat reservation could not be completed");
}

/** A provider failure must not cost the user a question. */
export async function releaseChatQuestion(workspaceId: string, idempotencyKey: string): Promise<void> {
  await prisma.usageLedgerEntry.updateMany({
    where: { workspaceId, idempotencyKey, kind: CHAT_KIND, units: { gt: 0 } },
    data: { units: 0, releasedAt: new Date() },
  });
}
