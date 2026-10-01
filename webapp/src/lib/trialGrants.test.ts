import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { reserveTrialGrant } from "./trialGrants";

afterEach(() => vi.unstubAllEnvs());
describe("trial issuance ceiling", () => {
  it("allows only one grant when concurrent signups compete for the last slot", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const before = (await prisma.trialGrantDay.findUnique({ where: { day } }))?.grants ?? 0;
    vi.stubEnv("MANAGED_HOSTING", "true");
    vi.stubEnv("MANAGED_TRIAL_DAILY_GRANTS", String(before + 1));
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => prisma.$transaction((tx) => reserveTrialGrant(tx))));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.trialGrantDay.findUniqueOrThrow({ where: { day } })).grants).toBe(before + 1);
  });
  it("fails closed when a managed runtime has no issuance budget", async () => {
    vi.stubEnv("MANAGED_HOSTING", "true");
    vi.stubEnv("MANAGED_TRIAL_DAILY_GRANTS", "");
    await expect(prisma.$transaction((tx) => reserveTrialGrant(tx))).rejects.toThrow();
  });
});
