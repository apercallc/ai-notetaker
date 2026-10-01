import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "./db";

export class ProviderBudgetError extends Error {
  constructor() {
    super("Hosted AI is temporarily unavailable. Your original audio is unchanged. Try again later.");
    this.name = "ProviderBudgetError";
  }
}

interface SpendContext { workspaceId: string; operationId: string; guards: Array<() => Promise<void>> }
const context = new AsyncLocalStorage<SpendContext>();
export function withProviderSpend<T>(workspaceId: string, operationId: string, work: () => Promise<T>): Promise<T> {
  return context.run({ workspaceId, operationId, guards: [] }, work);
}

export function addProviderLeaseGuard(guard: () => Promise<void>): void {
  context.getStore()?.guards.push(guard);
}

function configuredLimit(name: string): bigint {
  const value = process.env[name];
  // Explicit budgets are required in production managed mode. Self-hosted
  // installs and test fixtures retain their existing setup contract.
  if (!value && process.env.MANAGED_HOSTING !== "true") return 1_000_000_000_000n;
  if (!value || !/^\d+$/.test(value) || BigInt(value) > 1_000_000_000_000n) throw new ProviderBudgetError();
  return BigInt(value);
}

/** Cheap preflight protects upload bandwidth; provider reservation is still authoritative. */
export async function assertProviderAdmission(workspaceId: string, plan: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const checks = [
    { id: `global:${day}`, name: "MANAGED_DAILY_SPEND_MICROS" },
    { id: `workspace:${workspaceId}:${day}`, name: "MANAGED_WORKSPACE_DAILY_SPEND_MICROS" },
    ...(plan === "hosted_trial" ? [{ id: `trial:${day}`, name: "MANAGED_TRIAL_DAILY_SPEND_MICROS" }] : []),
  ];
  const rows = await prisma.providerSpendBucket.findMany({ where: { id: { in: checks.map((check) => check.id) } } });
  for (const check of checks) {
    if ((rows.find((row) => row.id === check.id)?.committedMicros ?? 0n) >= configuredLimit(check.name)) throw new ProviderBudgetError();
  }
}

/** Immutable attempts survive customer refunds, job deletion and process death. */
export async function reserveProviderAttempt(provider: string, estimatedMicros: number): Promise<string | null> {
  const scope = context.getStore();
  if (!scope) {
    if (process.env.NODE_ENV !== "test" && process.env.MANAGED_HOSTING === "true") throw new ProviderBudgetError();
    return null;
  }
  if (!Number.isSafeInteger(estimatedMicros) || estimatedMicros < 1) throw new ProviderBudgetError();
  for (const guard of scope.guards) await guard();
  const amount = BigInt(estimatedMicros);
  const day = new Date().toISOString().slice(0, 10);
  return prisma.$transaction(async (tx) => {
    const subscription = await tx.workspaceSubscription.findUnique({ where: { workspaceId: scope.workspaceId }, select: { plan: true } });
    const buckets = [
      { id: `global:${day}`, limit: configuredLimit("MANAGED_DAILY_SPEND_MICROS") },
      { id: `workspace:${scope.workspaceId}:${day}`, limit: configuredLimit("MANAGED_WORKSPACE_DAILY_SPEND_MICROS") },
      ...(subscription?.plan === "hosted_trial" ? [{ id: `trial:${day}`, limit: configuredLimit("MANAGED_TRIAL_DAILY_SPEND_MICROS") }] : []),
    ].sort((a, b) => a.id.localeCompare(b.id));
    for (const bucket of buckets) {
      await tx.providerSpendBucket.upsert({ where: { id: bucket.id }, create: { id: bucket.id, day }, update: {} });
      // Conditional increment is the atomic admission point across replicas.
      const reserved = await tx.providerSpendBucket.updateMany({
        where: { id: bucket.id, committedMicros: { lte: bucket.limit - amount } },
        data: { committedMicros: { increment: amount } },
      });
      if (reserved.count !== 1) throw new ProviderBudgetError();
    }
    const attempt = await tx.providerSpendAttempt.create({ data: {
      workspaceId: scope.workspaceId, operationId: scope.operationId, provider, day,
      reservedMicros: amount, chargedMicros: amount, bucketIds: buckets.map((bucket) => bucket.id),
    } });
    return attempt.id;
  });
}

/** Unknown/timeouts remain charged at their reservation; never refund ambiguous spend. */
export async function settleProviderAttempt(id: string | null, actualMicros?: number, httpStatus?: number): Promise<void> {
  if (!id) return;
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ProviderSpendAttempt" WHERE "id" = ${id} FOR UPDATE`;
    if (rows.length !== 1) return;
    const attempt = await tx.providerSpendAttempt.findUniqueOrThrow({ where: { id } });
    if (attempt.settledAt) return;
    const known = actualMicros !== undefined && Number.isSafeInteger(actualMicros) && actualMicros >= 0;
    const charged = known ? BigInt(actualMicros!) : attempt.reservedMicros;
    // Actual costs above an estimate are recorded as debt and block later
    // admission; reconciliation must never hide a pricing/model mismatch.
    const delta = charged - attempt.chargedMicros;
    for (const bucketId of [...attempt.bucketIds].sort()) {
      await tx.providerSpendBucket.update({ where: { id: bucketId }, data: { committedMicros: { increment: delta } } });
    }
    await tx.providerSpendAttempt.update({ where: { id }, data: {
      chargedMicros: charged, status: known ? "reported" : "ambiguous", httpStatus, settledAt: new Date(),
    } });
  });
}
