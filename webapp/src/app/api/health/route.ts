import { NextResponse } from "next/server";

// The one deliberate unauthenticated route — see docs/webapp-api.md. Its
// only job is letting the extension's settings page confirm "is this URL
// even a webapp instance" before asking the user for a token.
export async function GET() {
  return NextResponse.json({ ok: true });
}
