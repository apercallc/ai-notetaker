import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./db";
import {
  assignHostedTrial,
  getEntitlements,
  quotaWarning,
  reserveMeetingProcessing,
  usageWindow,
} from "./usageLedger";
import { createHostedWorkspaceWithOwner } from "./workspaces";
import { HOSTED_TRIAL_MEETINGS } from "./plans";

const now = new Date("2026-09-24T12:00:00.000Z");

function subscription(overrides: Partial<Parameters<typeof usageWindow>[0]> = {}) {
  return {
    plan: "hosted_pro",
    status: "active",
    graceEndsAt: null,
    currentPeriodStart: new Date("2026-09-10T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-10T00:00:00.000Z"),
    ...overrides,
  };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("usageWindow", () => {
  it("follows the Stripe billing period while a subscription covers now", () => {
    const window = usageWindow(subscription(), now);
    expect(window).toEqual({
      start: new Date("2026-09-10T00:00:00.000Z"),
      end: new Date("2026-10-10T00:00:00.000Z"),
      entryPeriodStart: new Date("2026-09-10T00:00:00.000Z"),
      source: "stripe",
    });
  });

  it("falls back to the calendar month when the Stripe period is stale or missing", () => {
    const stale = usageWindow(subscription({ currentPeriodEnd: new Date("2026-09-11T00:00:00.000Z") }), now);
    expect(stale.source).toBe("calendar");
    expect(stale.start).toEqual(new Date(Date.UTC(2026, 8, 1)));
    expect(stale.end).toEqual(new Date(Date.UTC(2026, 9, 1)));

    const noSubscription = usageWindow(null, now);
    expect(noSubscription.source).toBe("calendar");
    const localPlan = usageWindow(subscription({ plan: "local" }), now);
    expect(localPlan.source).toBe("calendar");
  });

  it("never resets the free trial window", () => {
    const window = usageWindow(subscription({ plan: "hosted_trial" }), now);
    expect(window.source).toBe("trial");
    expect(window.start).toEqual(new Date(0));
    expect(window.end).toBeNull();
  });
});

describe("quotaWarning", () => {
  it("flags nothing on unlimited/self-hosted plans", () => {
    expect(quotaWarning(0, 0)).toBe("none");
    expect(quotaWarning(0, 5)).toBe("none");
    expect(quotaWarning(1, 5)).toBe("none");
  });

  it("warns when usage is low or exhausted", () => {
    expect(quotaWarning(4, 5)).toBe("low");
    expect(quotaWarning(1, HOSTED_TRIAL_MEETINGS)).toBe("none");
    expect(quotaWarning(2, HOSTED_TRIAL_MEETINGS)).toBe("low");
    expect(quotaWarning(3, HOSTED_TRIAL_MEETINGS)).toBe("exhausted");
    expect(quotaWarning(5, 5)).toBe("exhausted");
    expect(quotaWarning(6, 5)).toBe("exhausted");
  });
});

describe("hosted trial", () => {
  it("is assigned to every new hosted workspace without a card", async () => {
    const { workspaceId } = await createHostedWorkspaceWithOwner(`trial-${randomUUID()}@example.com`, "hash", "Trial workspace");
    try {
      const entitlements = await getEntitlements(workspaceId);
      expect(entitlements).toMatchObject({
        plan: "hosted_trial",
        planLabel: "Hosted Free Trial",
        status: "trialing",
        used: 0,
        limit: HOSTED_TRIAL_MEETINGS,
        remaining: HOSTED_TRIAL_MEETINGS,
        canProcess: true,
        isTrial: true,
        trial: { limit: HOSTED_TRIAL_MEETINGS, used: 0, remaining: HOSTED_TRIAL_MEETINGS },
        warning: "none",
        period: { source: "trial", start: null, end: null },
      });

      await reserveMeetingProcessing(workspaceId, `trial-reserve-${workspaceId}`);
      const afterUse = await getEntitlements(workspaceId);
      expect(afterUse.trial).toMatchObject({ used: 1, remaining: 2 });
      expect(afterUse.warning).toBe("none");
      // Two of three used is the last usable meeting, so the UI must warn.
      await reserveMeetingProcessing(workspaceId, `trial-reserve-2-${workspaceId}`);
      expect((await getEntitlements(workspaceId)).warning).toBe("low");
      // The exhausted trial can process no more meetings.
      await reserveMeetingProcessing(workspaceId, `trial-reserve-3-${workspaceId}`);
      await expect(getEntitlements(workspaceId)).resolves.toMatchObject({ warning: "exhausted", canProcess: false });
      await expect(reserveMeetingProcessing(workspaceId, `trial-reserve-4-${workspaceId}`)).rejects.toThrow();
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
  });

  it("is idempotent and never downgrades an existing subscription", async () => {
    const workspaceId = randomUUID();
    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Trial idempotence workspace" } });
      await prisma.workspaceSubscription.create({
        data: { workspaceId, stripeCustomerId: "cus_trial_idem", plan: "hosted_pro", status: "active" },
      });
      await assignHostedTrial(prisma, workspaceId);
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({
        plan: "hosted_pro",
        status: "active",
      });

      // No subscription row yet: the trial is granted.
      const freshWorkspaceId = randomUUID();
      await prisma.workspace.create({ data: { id: freshWorkspaceId, name: "Trial grant workspace" } });
      await assignHostedTrial(prisma, freshWorkspaceId);
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: freshWorkspaceId } })).resolves.toMatchObject({
        plan: "hosted_trial",
        status: "trialing",
      });
      // A second grant changes nothing.
      await assignHostedTrial(prisma, freshWorkspaceId);
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: freshWorkspaceId } })).resolves.toMatchObject({
        plan: "hosted_trial",
        status: "trialing",
      });
      await prisma.workspace.delete({ where: { id: freshWorkspaceId } });
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
  });
});