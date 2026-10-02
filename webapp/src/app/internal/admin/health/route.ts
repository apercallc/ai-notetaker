import { authorizeAdminRequest, noStoreJson } from "../_auth";
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = authorizeAdminRequest(request);
  if (denied) return denied;
  const checkedAt = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return noStoreJson({ status: "healthy", checkedAt, components: [{ name: "database", status: "healthy" }] });
  } catch {
    return noStoreJson({ status: "outage", checkedAt, components: [{ name: "database", status: "outage" }] });
  }
}
