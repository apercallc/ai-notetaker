import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { createApiToken, DESKTOP_NOTES_SCOPE } from "@/lib/apiTokens";
import { contextFromRequest } from "@/lib/requestContext";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";

/**
 * Signing in on the desktop also connects its notes library to this workspace. The notes-only
 * token is revocable from the web Account page and is bound to the signed-in workspace; the
 * desktop stores it in the OS credential store and never uses it for anything but note sync.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const context = contextFromRequest(request);
    const token = await createApiToken(session.userId, {
      scope: DESKTOP_NOTES_SCOPE,
      workspaceId: session.workspaceId,
      label: "Desktop note sync (sign-in)",
      userAgent: context.userAgent,
    });
    return NextResponse.json({ token: token.token, expiresAt: token.expiresAt.toISOString() }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
