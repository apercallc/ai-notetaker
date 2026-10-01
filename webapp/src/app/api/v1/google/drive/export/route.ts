import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { exportMeetingToGoogleDrive, GoogleIntegrationError } from "@/lib/googleIntegration";
import { readManagedJson } from "@/lib/managedJobs";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  let body: unknown;
  try {
    body = await readManagedJson(request);
  } catch {
    return NextResponse.json({ error: "request body must be JSON", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  }
  const meetingId = body && typeof body === "object" && typeof (body as { meetingId?: unknown }).meetingId === "string" ? (body as { meetingId: string }).meetingId : "";
  try {
    const exported = await exportMeetingToGoogleDrive(session.userId, session.workspaceId, meetingId);
    return NextResponse.json(exported, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof GoogleIntegrationError) {
      return NextResponse.json({ error: error.publicMessage, requestId }, { status: error.status, headers: { "x-request-id": requestId } });
    }
    // Unexpected: logged and sent to error tracking with the request id, like every other managed route.
    return apiErrorResponse(error, { requestId, fallbackMessage: "Google Drive export failed. Try again later." });
  }
}
