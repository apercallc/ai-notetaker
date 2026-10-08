import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getAppUrl } from "@/lib/deploymentConfig";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { recordAudit } from "@/lib/audit";
import { SYNC_SUBSCRIPTION_REQUIRED_MESSAGE } from "@/lib/syncAccess";
import { writeBlock } from "@/lib/workspaceAccess";
import { createMeetingShare, SharingValidationError } from "@/lib/sharing";

/**
 * Extension-initiated share creation for the auto-share setting. The
 * extension calls this after notes complete (autoShareNotesWithAttendees) so
 * the attendee link exists without the user visiting the web app. Same
 * workspace scoping and the same share token machinery as the UI action; the
 * raw token is returned exactly once, to the authenticated caller.
 */
export async function POST(request: Request, context: { params: Promise<{ meetingId: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    if (await writeBlock(session.workspaceId)) {
      return NextResponse.json(
        { error: SYNC_SUBSCRIPTION_REQUIRED_MESSAGE, requestId },
        { status: 402, headers: { "x-request-id": requestId } },
      );
    }
    const { meetingId } = await context.params;
    if (!meetingId || meetingId.length > 128) {
      return NextResponse.json({ error: "meetingId is required", requestId }, { status: 400, headers: { "x-request-id": requestId } });
    }
    const share = await createMeetingShare(session.workspaceId, meetingId);
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "share.create", targetType: "meeting", targetId: meetingId, metadata: { via: "extension" } });
    return NextResponse.json(
      {
        shareId: share.id,
        // The full share URL is built from the canonical configured origin,
        // never from request headers.
        shareUrl: `${getAppUrl()}/share/${share.token}`,
        expiresAt: share.expiresAt?.toISOString() ?? null,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof SharingValidationError) {
      return NextResponse.json({ error: error.message, requestId }, { status: 400, headers: { "x-request-id": requestId } });
    }
    return apiErrorResponse(error, { requestId });
  }
}
