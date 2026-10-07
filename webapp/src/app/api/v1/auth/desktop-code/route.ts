import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { createApiToken } from "@/lib/apiTokens";
import { consumeAuthToken } from "@/lib/authTokens";
import { contextFromRequest } from "@/lib/requestContext";
import { getUserDefaultWorkspaceId, getUserRole } from "@/lib/workspaces";
import { getEntitlements } from "@/lib/usageLedger";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { ManagedValidationError, readManagedJson } from "@/lib/managedJobs";
import { prisma } from "@/lib/db";

/**
 * Signs the desktop app in with a one-time code created on the web app's Connect page. This is how
 * accounts without a password (Google sign-in) reach the desktop app, and the reply has the same
 * shape as the password sign-in so the desktop handles both identically.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const code = typeof (body as Record<string, unknown>).code === "string" ? ((body as Record<string, string>).code).trim() : "";
    if (!code) throw new ManagedValidationError("code is required");

    const record = await consumeAuthToken(code, "desktop_connect");
    if (!record?.userId) {
      return NextResponse.json({ error: "That code is not valid or has expired. Create a new one in the web app.", requestId }, { status: 401, headers: { "x-request-id": requestId } });
    }
    const user = await prisma.user.findUnique({ where: { id: record.userId }, select: { id: true, email: true } });
    if (!user) return NextResponse.json({ error: "account not found", requestId }, { status: 401, headers: { "x-request-id": requestId } });
    // The code carries the workspace the person was working in; fall back to their default if they left it.
    let workspaceId = record.workspaceId;
    let role = workspaceId ? await getUserRole(user.id, workspaceId) : null;
    if (!role) {
      workspaceId = await getUserDefaultWorkspaceId(user.id);
      role = workspaceId ? await getUserRole(user.id, workspaceId) : null;
    }
    if (!workspaceId || !role) return NextResponse.json({ error: "account has no workspace", requestId }, { status: 403, headers: { "x-request-id": requestId } });

    const context = contextFromRequest(request);
    const session = await createApiToken(user.id, { userAgent: context.userAgent, label: "Desktop sign-in (browser)" });
    const entitlements = await getEntitlements(workspaceId);
    return NextResponse.json(
      { accessToken: session.token, expiresAt: session.expiresAt, accountId: user.id, workspaceId, plan: entitlements.plan, role, email: user.email },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
