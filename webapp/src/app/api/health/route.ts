import { NextResponse } from "next/server";
import { managedConfigurationStatus } from "@/lib/deploymentConfig";

// The one deliberate unauthenticated route — see docs/webapp-api.md. Its
// only job is letting the extension's settings page confirm "is this URL
// even a webapp instance" before asking the user for a token.
export async function GET() {
  const managed = managedConfigurationStatus();
  if (!managed.enabled) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: true, mode: "managed", managedReady: managed.ready, objectStorage: managed.objectStorage });
}
