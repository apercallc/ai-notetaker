import { prisma } from "./db";
import { randomUUID } from "node:crypto";

export class ManagedCapacityError extends Error {}

/** Global processing ceiling includes standalone replicas and legacy HTTP runs. */
export async function withWorkerSlot(work: (assertLease: () => Promise<void>) => Promise<void>): Promise<void> {
  const raw = process.env.MANAGED_WORKER_CONCURRENCY ?? "2";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 32) throw new Error("MANAGED_WORKER_CONCURRENCY must be between 1 and 32");
  const token = randomUUID();
  const until = () => new Date(Date.now() + 5 * 60_000);
  let slot: string | undefined;
  for (let index = 0; index < Number(raw); index += 1) {
    const id = `worker-slot:${index}`;
    await prisma.maintenanceCursor.upsert({ where: { id }, create: { id }, update: {} });
    const acquired = await prisma.maintenanceCursor.updateMany({ where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseToken: token, leaseUntil: until() } });
    if (acquired.count) { slot = id; break; }
  }
  if (!slot) throw new ManagedCapacityError("Hosted processing capacity is busy");
  const id = slot;
  const heartbeat = setInterval(() => {
    void prisma.maintenanceCursor.updateMany({ where: { id, leaseToken: token }, data: { leaseUntil: until() } }).catch(() => undefined);
  }, 60_000);
  heartbeat.unref();
  const assertLease = async () => {
    const valid = await prisma.maintenanceCursor.count({ where: { id, leaseToken: token, leaseUntil: { gt: new Date() } } });
    if (!valid) throw new ManagedCapacityError("Hosted processing lease was lost");
  };
  try { await work(assertLease); } finally {
    clearInterval(heartbeat);
    await prisma.maintenanceCursor.updateMany({ where: { id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
  }
}

export async function readMaintenanceCursor(id: string): Promise<string | undefined> {
  return (await prisma.maintenanceCursor.findUnique({ where: { id } }))?.value ?? undefined;
}
export async function writeMaintenanceCursor(id: string, value: string | undefined): Promise<void> {
  await prisma.maintenanceCursor.upsert({ where: { id }, create: { id, value }, update: { value: value ?? null } });
}

/** Shared lease avoids multiplying maintenance/object operations per replica. */
export async function withMaintenanceLease(work: () => Promise<void>): Promise<void> {
  const id = "cleaner-lease";
  const leaseToken = randomUUID();
  const until = () => new Date(Date.now() + 5 * 60_000);
  await prisma.maintenanceCursor.upsert({ where: { id }, create: { id }, update: {} });
  const claimed = await prisma.maintenanceCursor.updateMany({
    where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { leaseToken, leaseUntil: until() },
  });
  if (!claimed.count) return;
  const timer = setInterval(() => {
    void prisma.maintenanceCursor.updateMany({ where: { id, leaseToken }, data: { leaseUntil: until() } }).catch(() => undefined);
  }, 60_000);
  timer.unref();
  try { await work(); } finally {
    clearInterval(timer);
    await prisma.maintenanceCursor.updateMany({ where: { id, leaseToken }, data: { leaseToken: null, leaseUntil: null } });
  }
}
