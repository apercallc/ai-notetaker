import { NextResponse } from "next/server";
import { managedConfigurationStatus } from "@/lib/deploymentConfig";
import { prisma } from "@/lib/db";

// The one deliberate unauthenticated route — see docs/webapp-api.md. Its
// only job is letting the extension's settings page confirm "is this URL
// even a webapp instance" before asking the user for a token.
export async function GET() {
  // A deploy that cannot reach its database must fail the platform health
  // check instead of going live and erroring on every request.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  const managed = managedConfigurationStatus();
  if (!managed.enabled) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: true, mode: "managed", managedReady: managed.ready, objectStorage: managed.objectStorage });
}
