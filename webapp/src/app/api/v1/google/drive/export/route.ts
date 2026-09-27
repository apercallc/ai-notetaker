import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/apiErrors";
import { exportMeetingToGoogleDrive, GoogleIntegrationError } from "@/lib/googleIntegration";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  }
  const meetingId = body && typeof body === "object" && typeof (body as { meetingId?: unknown }).meetingId === "string" ? (body as { meetingId: string }).meetingId : "";
  try {
    const exported = await exportMeetingToGoogleDrive(session.userId, session.workspaceId, meetingId);
    return NextResponse.json(exported, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    const status = error instanceof GoogleIntegrationError ? error.status : 500;
    const message = error instanceof GoogleIntegrationError ? error.publicMessage : "Google Drive export failed. Try again later.";
    return NextResponse.json({ error: message, requestId }, { status, headers: { "x-request-id": requestId } });
  }
}
