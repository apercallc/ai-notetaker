import "dotenv/config";
import { prisma } from "../src/lib/db";

// Operator-only command: no public route, transcripts, credentials or audio.
const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Use a UTC date: YYYY-MM-DD");
try {
  const [costs, buckets, trials, queue] = await Promise.all([
    prisma.providerSpendAttempt.groupBy({ by: ["provider", "status"], where: { day }, _count: true, _sum: { reservedMicros: true, chargedMicros: true } }),
    prisma.providerSpendBucket.findMany({ where: { id: { in: [`global:${day}`, `trial:${day}`] } } }),
    prisma.trialGrantDay.findUnique({ where: { day } }),
    prisma.processingJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const limits: Record<string, string | undefined> = { global: process.env.MANAGED_DAILY_SPEND_MICROS, trial: process.env.MANAGED_TRIAL_DAILY_SPEND_MICROS };
  const budget = buckets.map((bucket) => {
    const scope = bucket.id.split(":")[0];
    const limit = limits[scope] && /^\d+$/.test(limits[scope]!) ? BigInt(limits[scope]!) : 0n;
    const percent = limit > 0 ? Number(bucket.committedMicros * 100n / limit) : null;
    return { scope, committedMicros: bucket.committedMicros, percent, alert: percent === null || percent >= 100 ? "exhausted-or-unconfigured" : percent >= 80 ? "80-percent" : percent >= 50 ? "50-percent" : "normal" };
  });
  console.log(JSON.stringify({ day, providerAttempts: costs, budget, trialGrants: trials?.grants ?? 0, oldestQueuedSeconds: queue ? Math.floor((Date.now() - queue.createdAt.getTime()) / 1_000) : 0 }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
} finally { await prisma.$disconnect(); }
