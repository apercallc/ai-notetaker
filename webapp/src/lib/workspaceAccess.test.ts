import { afterEach, describe, expect, it, vi } from "vitest";

const { findSubscription } = vi.hoisted(() => ({ findSubscription: vi.fn() }));
vi.mock("./db", () => ({ prisma: { workspaceSubscription: { findUnique: findSubscription } } }));

import { LAPSED_READ_ONLY_MESSAGE, NO_PLAN_MESSAGE, accessFromSubscription, getWorkspaceAccess, writeBlock } from "./workspaceAccess";

const now = new Date("2026-10-07T12:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
  findSubscription.mockReset();
});

describe("what a workspace may do when its plan is not active", () => {
  it("is fully writable on an active Pro or Team plan and through the payment grace window", () => {
    expect(accessFromSubscription({ plan: "hosted_pro", status: "active", graceEndsAt: null }, now)).toEqual({ writable: true, lapsed: false });
    expect(accessFromSubscription({ plan: "hosted_team", status: "past_due", graceEndsAt: new Date(now.getTime() + 1_000) }, now)).toEqual({ writable: true, lapsed: false });
  });

  it("is read-only and lapsed once a plan ended, however it ended", () => {
    for (const status of ["canceled", "unpaid", "paused", "incomplete_expired"]) {
      expect(accessFromSubscription({ plan: "hosted_pro", status, graceEndsAt: null }, now)).toEqual({ writable: false, lapsed: true });
    }
    expect(accessFromSubscription({ plan: "hosted_team", status: "past_due", graceEndsAt: new Date(now.getTime() - 1) }, now)).toEqual({ writable: false, lapsed: true });
    // A plan row that Stripe reset to the free plan still remembers that a customer existed.
    expect(accessFromSubscription({ plan: "local", status: "canceled", graceEndsAt: null, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }, now)).toEqual({ writable: false, lapsed: true });
    // A retired trial counts as a plan that ended.
    expect(accessFromSubscription({ plan: "hosted_trial", status: "trialing", graceEndsAt: null }, now)).toEqual({ writable: false, lapsed: true });
  });

  it("is read-only but not lapsed for an account that never had a plan", () => {
    expect(accessFromSubscription(null, now)).toEqual({ writable: false, lapsed: false });
    expect(accessFromSubscription({ plan: "local", status: "inactive", graceEndsAt: null }, now)).toEqual({ writable: false, lapsed: false });
  });

  it("says the right thing in each case, and nothing when writable", async () => {
    vi.stubEnv("MANAGED_HOSTING", "true");
    findSubscription.mockResolvedValueOnce({ plan: "hosted_pro", status: "canceled", graceEndsAt: null, stripeSubscriptionId: "sub", stripeCustomerId: "cus" });
    expect(await writeBlock("w")).toBe(LAPSED_READ_ONLY_MESSAGE);
    findSubscription.mockResolvedValueOnce(null);
    expect(await writeBlock("w")).toBe(NO_PLAN_MESSAGE);
    findSubscription.mockResolvedValueOnce({ plan: "hosted_team", status: "active", graceEndsAt: null });
    expect(await writeBlock("w")).toBeNull();
  });

  it("never blocks a deployment without managed hosting", async () => {
    vi.stubEnv("MANAGED_HOSTING", "false");
    expect(await getWorkspaceAccess("w")).toEqual({ writable: true, lapsed: false });
    expect(findSubscription).not.toHaveBeenCalled();
  });

  it("promises the user their notes are safe and readable", () => {
    expect(LAPSED_READ_ONLY_MESSAGE).toMatch(/read, search and export every note/);
  });
});
