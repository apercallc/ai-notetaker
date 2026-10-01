import type { Prisma } from "@prisma/client";

export class TrialGrantLimitError extends Error {}

/** Global issuance ceiling in addition to shared signup throttles and spend limits. */
export async function reserveTrialGrant(tx: Prisma.TransactionClient): Promise<void> {
  const value = process.env.MANAGED_TRIAL_DAILY_GRANTS;
  if (!value && process.env.MANAGED_HOSTING !== "true") return;
  if (!value || !/^\d+$/.test(value) || Number(value) > 100_000) throw new TrialGrantLimitError();
  const day = new Date().toISOString().slice(0, 10);
  await tx.trialGrantDay.upsert({ where: { day }, create: { day }, update: {} });
  const claimed = await tx.trialGrantDay.updateMany({ where: { day, grants: { lt: Number(value) } }, data: { grants: { increment: 1 } } });
  if (!claimed.count) throw new TrialGrantLimitError();
}
