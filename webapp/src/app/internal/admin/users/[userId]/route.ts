import { authorizeAdminRequest, noStoreJson } from "../../_auth";
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const denied = authorizeAdminRequest(request);
  if (denied) return denied;
  const { userId } = await context.params;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, createdAt: true } });
    if (!user) return noStoreJson({ error: "User not found" }, 404);
    return noStoreJson({ id: user.id, email: user.email, createdAt: user.createdAt.toISOString(), status: "unknown", availableSupportActions: [] });
  } catch {
    return noStoreJson({ error: "Service unavailable" }, 503);
  }
}
