import { authorizeAdminRequest, isValidWindow, noStoreJson } from "../_auth";
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = authorizeAdminRequest(request);
  if (denied) return denied;
  const window = isValidWindow(request.nextUrl.searchParams.get("from"), request.nextUrl.searchParams.get("to"));
  if (!window) return noStoreJson({ error: "Invalid time window" }, 400);
  try {
    const [totalUsers, newUsers, trend] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: window.from, lt: window.to } } }),
      prisma.$queryRaw<Array<{ date: string; users: number }>>`
        SELECT ("createdAt" AT TIME ZONE 'UTC')::date::text AS date, COUNT(*)::int AS users
          FROM "User"
         WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
         GROUP BY 1 ORDER BY 1 LIMIT 400
      `,
    ]);
    return noStoreJson({
      period: { from: window.from.toISOString(), to: window.to.toISOString(), timezone: "UTC" },
      asOf: new Date().toISOString(),
      metrics: { totalUsers, newUsers },
      trends: trend.map((point) => ({ date: point.date, users: point.users })),
    });
  } catch {
    return noStoreJson({ error: "Service unavailable" }, 503);
  }
}
