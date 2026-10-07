import { describe, expect, it } from "vitest";
import { hasSyncAccess } from "./syncAccess";

const now = new Date("2026-10-07T12:00:00Z");

describe("hasSyncAccess", () => {
  it("is off without a subscription or on the free and retired plans", () => {
    expect(hasSyncAccess(null, now)).toBe(false);
    expect(hasSyncAccess(undefined, now)).toBe(false);
    expect(hasSyncAccess({ plan: "local", status: "inactive", graceEndsAt: null }, now)).toBe(false);
    expect(hasSyncAccess({ plan: "hosted_trial", status: "trialing", graceEndsAt: null }, now)).toBe(false);
  });

  it("is on for active or trialing Pro and Team", () => {
    expect(hasSyncAccess({ plan: "hosted_pro", status: "active", graceEndsAt: null }, now)).toBe(true);
    expect(hasSyncAccess({ plan: "hosted_team", status: "trialing", graceEndsAt: null }, now)).toBe(true);
  });

  it("keeps sync through the payment grace window, up to and including its last instant", () => {
    expect(hasSyncAccess({ plan: "hosted_pro", status: "past_due", graceEndsAt: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(hasSyncAccess({ plan: "hosted_pro", status: "past_due", graceEndsAt: now }, now)).toBe(true);
    expect(hasSyncAccess({ plan: "hosted_pro", status: "past_due", graceEndsAt: new Date(now.getTime() - 1) }, now)).toBe(false);
    expect(hasSyncAccess({ plan: "hosted_pro", status: "past_due", graceEndsAt: null }, now)).toBe(false);
  });

  it("is off for canceled, unpaid, paused and incomplete subscriptions", () => {
    for (const status of ["canceled", "unpaid", "paused", "incomplete", "incomplete_expired"]) {
      expect(hasSyncAccess({ plan: "hosted_team", status, graceEndsAt: null }, now)).toBe(false);
    }
  });
});
