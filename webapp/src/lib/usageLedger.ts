import { prisma } from "./db";

export type ManagedPlan = "local" | "hosted_trial" | "hosted_pro" | "hosted_team";

const PLAN_MEETING_LIMITS: Record<ManagedPlan, number> = {
  local: 0,
  hosted_trial: 3,
  hosted_pro: 1_000,
  hosted_team: 10_000,
};
function hasProcessingAccess(subscription: { status: string; graceEndsAt: Date | null } | null, now = new Date()): boolean {
  return subscription?.status === "active" || subscription?.status === "trialing" ||
    (subscription?.status === "past_due" && Boolean(subscription.graceEndsAt && subscription.graceEndsAt >= now));
}

function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getEntitlements(workspaceId: string) {
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  const plan = (subscription?.plan ?? "local") as ManagedPlan;
  const currentPeriodStart = periodStart();
  const used = await prisma.usageLedgerEntry.aggregate({
    where: { workspaceId, periodStart: currentPeriodStart, kind: "meeting_processing" },
    _sum: { units: true },
  });
  const limit = PLAN_MEETING_LIMITS[plan] ?? 0;
  return {
    plan,
    status: subscription?.status ?? "inactive",
    used: used._sum.units ?? 0,
    limit,
    remaining: Math.max(0, limit - (used._sum.units ?? 0)),
    inPaymentGrace: subscription?.status === "past_due" && Boolean(subscription.graceEndsAt && subscription.graceEndsAt >= new Date()),
    canProcess: hasProcessingAccess(subscription) && limit > (used._sum.units ?? 0),
  };
}

export async function reserveMeetingProcessing(workspaceId: string, idempotencyKey: string): Promise<{ alreadyReserved: boolean }> {
  // The entitlement check and ledger insert must share a serializable
  // transaction. A check-then-insert sequence lets two simultaneous uploads
  // both observe the same remaining unit and oversubscribe a plan.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.usageLedgerEntry.findUnique({
            where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
          });
          if (existing?.units && existing.units > 0) return { alreadyReserved: true };

          const subscription = await tx.workspaceSubscription.findUnique({ where: { workspaceId } });
          const plan = (subscription?.plan ?? "local") as ManagedPlan;
          const limit = PLAN_MEETING_LIMITS[plan] ?? 0;
          const currentPeriodStart = periodStart();
          const used = await tx.usageLedgerEntry.aggregate({
            where: { workspaceId, periodStart: currentPeriodStart, kind: "meeting_processing" },
            _sum: { units: true },
          });
          if (
            !hasProcessingAccess(subscription) ||
            limit <= (used._sum.units ?? 0)
          ) {
            throw new Error("managed processing entitlement is unavailable");
          }

          if (existing) {
            await tx.usageLedgerEntry.update({
              where: { id: existing.id },
              data: { periodStart: currentPeriodStart, units: 1, releasedAt: null },
            });
          } else {
            await tx.usageLedgerEntry.create({
              data: {
                workspaceId,
                periodStart: currentPeriodStart,
                kind: "meeting_processing",
                units: 1,
                idempotencyKey,
              },
            });
          }
          return { alreadyReserved: false };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      // PostgreSQL can abort a serializable transaction under contention. A
      // bounded retry preserves the API's idempotent behavior without making
      // a transient conflict visible as a quota failure.
      if ((error as { code?: string }).code === "P2034" && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("managed processing reservation could not be completed");
}

/**
 * A provider failure must not consume a successful-operation entitlement.
 * Keeping the row as a zero-unit release preserves the audit/idempotency key;
 * a later retry can reactivate the same reservation atomically.
 */
export async function releaseMeetingProcessing(workspaceId: string, idempotencyKey: string): Promise<void> {
  await prisma.usageLedgerEntry.updateMany({
    where: { workspaceId, idempotencyKey, kind: "meeting_processing", units: { gt: 0 } },
    data: { units: 0, releasedAt: new Date() },
  });
}
