import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { addProviderLeaseGuard, assertProviderAdmission, reserveProviderAttempt, settleProviderAttempt, withProviderSpend } from "./providerSpend";
import { providerRequest } from "./managedWorker";

const workspaces: string[] = [];
const buckets: string[] = [];
async function fixture(plan = "hosted_pro") {
  const id = randomUUID();
  workspaces.push(id);
  await prisma.workspace.create({ data: { id, name: "Spend fixture", subscription: { create: { plan, status: "active" } } } });
  buckets.push(`workspace:${id}:${new Date().toISOString().slice(0, 10)}`);
  return id;
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await prisma.providerSpendAttempt.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.providerSpendBucket.deleteMany({ where: { id: { in: buckets } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  workspaces.length = 0; buckets.length = 0;
});

describe("durable provider spending", () => {
  it("rejects invalid estimates and lost job leases before reserving money", async () => {
    const id = await fixture();
    await expect(withProviderSpend(id, "invalid", () => reserveProviderAttempt("fixture", -1))).rejects.toThrow("temporarily unavailable");
    await expect(withProviderSpend(id, "lost-lease", async () => {
      addProviderLeaseGuard(async () => { throw new Error("lease lost"); });
      await reserveProviderAttempt("fixture", 100);
    })).rejects.toThrow("lease lost");
    expect(await prisma.providerSpendAttempt.count({ where: { workspaceId: id } })).toBe(0);
    await expect(settleProviderAttempt(null)).resolves.toBeUndefined();
    await expect(settleProviderAttempt(randomUUID())).resolves.toBeUndefined();
  });

  it("keeps unscoped self-hosted calls independent of managed budgets", async () => {
    vi.stubEnv("MANAGED_HOSTING", "false");
    vi.stubEnv("MANAGED_DAILY_SPEND_MICROS", "");
    await expect(reserveProviderAttempt("fixture", 100)).resolves.toBeNull();
    const id = await fixture();
    await expect(withProviderSpend(id, "self-hosted", () => reserveProviderAttempt("fixture", 100))).resolves.toEqual(expect.any(String));
  });
  it("atomically enforces the workspace cap under concurrent admission", async () => {
    const id = await fixture();
    vi.stubEnv("MANAGED_WORKSPACE_DAILY_SPEND_MICROS", "100");
    const results = await withProviderSpend(id, "concurrency", () => Promise.allSettled(Array.from({ length: 8 }, () => reserveProviderAttempt("fixture", 60))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.providerSpendAttempt.count({ where: { workspaceId: id } })).toBe(1);
    expect((await prisma.providerSpendBucket.findUniqueOrThrow({ where: { id: buckets[0] } })).committedMicros).toBe(60n);
  });
  it("keeps ambiguous spend and reconciles reported costs once", async () => {
    const id = await fixture();
    const attempt = await withProviderSpend(id, "settle", () => reserveProviderAttempt("fixture", 100));
    await settleProviderAttempt(attempt);
    await settleProviderAttempt(attempt, 0);
    expect((await prisma.providerSpendAttempt.findUniqueOrThrow({ where: { id: attempt! } })).chargedMicros).toBe(100n);
    const known = await withProviderSpend(id, "reported", () => reserveProviderAttempt("fixture", 100));
    await settleProviderAttempt(known, 30, 200);
    expect((await prisma.providerSpendBucket.findUniqueOrThrow({ where: { id: buckets[0] } })).committedMicros).toBe(130n);
    await prisma.workspace.delete({ where: { id } });
    expect(await prisma.providerSpendAttempt.count({ where: { workspaceId: id } })).toBe(2);
  });
  it("does not call the provider again once a failed attempt consumed the budget", async () => {
    const id = await fixture();
    vi.stubEnv("MANAGED_WORKSPACE_DAILY_SPEND_MICROS", "100");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    await expect(withProviderSpend(id, "retry", () => providerRequest("https://provider.test", {}, "fixture", { spendMicros: 100 }))).rejects.toThrow("temporarily unavailable");
    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(assertProviderAdmission(id, "hosted_pro")).rejects.toThrow("temporarily unavailable");
  });
  it("fails closed for missing production budgets and unscoped calls", async () => {
    const id = await fixture();
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("MANAGED_HOSTING", "true");
    vi.stubEnv("MANAGED_DAILY_SPEND_MICROS", "");
    await expect(reserveProviderAttempt("fixture", 10)).rejects.toThrow("temporarily unavailable");
    await expect(withProviderSpend(id, "missing", () => reserveProviderAttempt("fixture", 10))).rejects.toThrow("temporarily unavailable");
  });
});
