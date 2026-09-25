import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { HOSTED_TRIAL_MEETINGS, PLAN_MEETING_LIMITS, isManagedPlan, planLabel, type ManagedPlan } from "./plans";

export type { ManagedPlan } from "./plans";

const UNITS_KIND = "meeting_processing";

type SubscriptionLike = {
  plan: string;
  status: string;
  graceEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
} | null;

function hasProcessingAccess(subscription: SubscriptionLike, now = new Date()): boolean {
  return subscription?.status === "active" || subscription?.status === "trialing" ||
    (subscription?.status === "past_due" && Boolean(subscription.graceEndsAt && subscription.graceEndsAt >= now));
}

function calendarMonth(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export interface UsageWindow {
  /** Ledger rows with periodStart >= start (and < end when set) count against the plan. */
  start: Date;
  end: Date | null;
  /** Bucket key stored on new ledger rows. */
  entryPeriodStart: Date;
  source: "stripe" | "calendar" | "trial";
}

/**
 * Usage resets with the billing period the customer actually pays for. While a
 * Stripe subscription reports a period that contains "now" the window is that
 * period; otherwise (no subscription, or webhook data is stale) it is the UTC
 * calendar month. The free trial allowance is a one-time grant, so its window
 * never resets.
 */
export function usageWindow(subscription: SubscriptionLike, now = new Date()): UsageWindow {
  const month = calendarMonth(now);
  if (subscription?.plan === "hosted_trial") {
    return { start: new Date(0), end: null, entryPeriodStart: month.start, source: "trial" };
  }
  if (
    subscription?.currentPeriodStart && subscription.currentPeriodEnd &&
    subscription.currentPeriodStart <= now && now < subscription.currentPeriodEnd &&
    subscription.plan !== "local"
  ) {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd, entryPeriodStart: subscription.currentPeriodStart, source: "stripe" };
  }
  return { start: month.start, end: month.end, entryPeriodStart: month.start, source: "calendar" };
}

function usageWhere(workspaceId: string, window: UsageWindow) {
  return {
    workspaceId,
    kind: UNITS_KIND,
    periodStart: { gte: window.start, ...(window.end ? { lt: window.end } : {}) },
  };
}

function planLimit(plan: string): number {
  return isManagedPlan(plan) ? PLAN_MEETING_LIMITS[plan] : 0;
}

export type QuotaWarning = "none" | "low" | "exhausted";

export function quotaWarning(used: number, limit: number): QuotaWarning {
  if (limit <= 0) return "none";
  if (used >= limit) return "exhausted";
  const nearlyOut = used / limit >= 0.8 || (limit <= HOSTED_TRIAL_MEETINGS && limit - used <= 1);
  return nearlyOut ? "low" : "none";
}

export async function getEntitlements(workspaceId: string) {
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  const plan = (subscription?.plan ?? "local") as ManagedPlan;
  const now = new Date();
  const window = usageWindow(subscription, now);
  const aggregate = await prisma.usageLedgerEntry.aggregate({ where: usageWhere(workspaceId, window), _sum: { units: true } });
  const used = aggregate._sum.units ?? 0;
  const limit = planLimit(plan);
  const remaining = Math.max(0, limit - used);
  const inPaymentGrace = subscription?.status === "past_due" && Boolean(subscription.graceEndsAt && subscription.graceEndsAt >= now);
  return {
    plan,
    planLabel: planLabel(plan),
    status: subscription?.status ?? "inactive",
    used,
    limit,
    remaining,
    inPaymentGrace,
    graceEndsAt: inPaymentGrace ? subscription?.graceEndsAt?.toISOString() ?? null : null,
    canProcess: hasProcessingAccess(subscription, now) && limit > used,
    period: {
      source: window.source,
      start: window.source === "trial" ? null : window.start.toISOString(),
      end: window.end?.toISOString() ?? null,
    },
    isTrial: plan === "hosted_trial",
    /** Free allowance for new hosted workspaces; null once the workspace has left the trial plan. */
    trial: plan === "hosted_trial" ? { limit, used, remaining } : null,
    warning: quotaWarning(used, limit),
  };
}

/**
 * Gives a hosted workspace the no-card trial allowance. Idempotent and never
 * downgrades: a workspace that already has any subscription row (paid,
 * canceled, or an earlier trial) is left untouched.
 */
export async function assignHostedTrial(client: Prisma.TransactionClient | typeof prisma, workspaceId: string): Promise<void> {
  await client.workspaceSubscription.upsert({
    where: { workspaceId },
    create: { workspaceId, plan: "hosted_trial", status: "trialing" },
    update: {},
  });
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
          const limit = planLimit(subscription?.plan ?? "local");
          const window = usageWindow(subscription);
          const currentPeriodStart = window.entryPeriodStart;
          const used = await tx.usageLedgerEntry.aggregate({
            where: usageWhere(workspaceId, window),
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
                kind: UNITS_KIND,
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
    where: { workspaceId, idempotencyKey, kind: UNITS_KIND, units: { gt: 0 } },
    data: { units: 0, releasedAt: new Date() },
  });
}
