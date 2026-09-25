import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/apiErrors";
import { findCurrentGoogleCalendarEvent, GoogleIntegrationError } from "@/lib/googleIntegration";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const event = await findCurrentGoogleCalendarEvent(session.userId);
    return NextResponse.json({ event }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const status = error instanceof GoogleIntegrationError ? error.status : 500;
    const message = error instanceof GoogleIntegrationError ? error.publicMessage : "Google Calendar is unavailable. Try again later.";
    return NextResponse.json({ error: message, requestId }, { status, headers: { "x-request-id": requestId } });
  }
}
