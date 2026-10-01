import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { readMaintenanceCursor, writeMaintenanceCursor, withWorkerSlot, withMaintenanceLease } from "./maintenanceCursor";

afterEach(() => vi.unstubAllEnvs());
describe("durable maintenance and capacity", () => {
  it("excludes another cleaner and releases its lease even when cleanup fails", async () => {
    await prisma.maintenanceCursor.deleteMany({ where: { id: "cleaner-lease" } });
    const competing = vi.fn(async () => undefined);
    await expect(withMaintenanceLease(async () => {
      await withMaintenanceLease(competing);
      expect(competing).not.toHaveBeenCalled();
      throw new Error("object store unavailable");
    })).rejects.toThrow("object store unavailable");
    const row = await prisma.maintenanceCursor.findUniqueOrThrow({ where: { id: "cleaner-lease" } });
    expect(row.leaseToken).toBeNull();
    expect(row.leaseUntil).toBeNull();
    await withMaintenanceLease(competing);
    expect(competing).toHaveBeenCalledOnce();
  });

  it("rejects invalid replica limits before allocating slots", async () => {
    vi.stubEnv("MANAGED_WORKER_CONCURRENCY", "0");
    await expect(withWorkerSlot(async () => undefined)).rejects.toThrow("between 1 and 32");
  });
  it("persists cursors across module reloads and clears completed sweeps", async () => {
    await writeMaintenanceCursor("fixture-cursor", "next-page");
    expect(await readMaintenanceCursor("fixture-cursor")).toBe("next-page");
    await writeMaintenanceCursor("fixture-cursor", undefined);
    expect(await readMaintenanceCursor("fixture-cursor")).toBeUndefined();
    await prisma.maintenanceCursor.delete({ where: { id: "fixture-cursor" } });
  });
  it("bounds concurrent jobs globally and rejects a lost slot", async () => {
    vi.stubEnv("MANAGED_WORKER_CONCURRENCY", "1");
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = withWorkerSlot(async (assertLease) => { await assertLease(); started(); await wait; });
    await ready;
    try { await expect(withWorkerSlot(async () => undefined)).rejects.toThrow("capacity"); }
    finally { release(); await first; }
    await withWorkerSlot(async (assertLease) => {
      await prisma.maintenanceCursor.update({ where: { id: "worker-slot:0" }, data: { leaseToken: "replacement", leaseUntil: new Date(0) } });
      await expect(assertLease()).rejects.toThrow("lease was lost");
    });
  });
});
