import { authorizeAdminRequest, decodeAdminCursor, encodeAdminCursor, noStoreJson } from "../_auth";
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = authorizeAdminRequest(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() ?? "";
  const limitValue = params.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  const cursor = decodeAdminCursor(params.get("cursor"));
  if (q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50 || cursor === undefined) {
    return noStoreJson({ error: "Invalid search or cursor" }, 400);
  }
  try {
    const rows = await prisma.user.findMany({
      where: {
        ...(q ? { email: { contains: q, mode: "insensitive" } } : {}),
        ...(cursor ? { OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ] } : {}),
      },
      select: { id: true, email: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return noStoreJson({
      users: page.map((user) => ({ id: user.id, email: user.email, createdAt: user.createdAt.toISOString(), status: "unknown", availableSupportActions: [] })),
      nextCursor: hasMore ? encodeAdminCursor(page[page.length - 1]!) : null,
    });
  } catch {
    return noStoreJson({ error: "Service unavailable" }, 503);
  }
}
