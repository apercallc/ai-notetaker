import { NextResponse } from "next/server";
import { createApiToken } from "@/lib/apiTokens";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getEntitlements } from "@/lib/usageLedger";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { ManagedValidationError, readManagedJson } from "@/lib/managedJobs";
import { consumeGoogleExtensionCode } from "@/lib/googleIntegration";
import { contextFromRequest } from "@/lib/requestContext";
import { prisma } from "@/lib/db";
import { getUserRole } from "@/lib/workspaces";

/** Exchange a one-use PKCE code for the same managed token shape as password sign-in. */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });

  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    const code = typeof value.code === "string" ? value.code : "";
    const codeVerifier = typeof value.codeVerifier === "string" ? value.codeVerifier : "";
    if (!code || !codeVerifier) throw new ManagedValidationError("code and codeVerifier are required");

    const exchanged = await consumeGoogleExtensionCode(code, codeVerifier);
    if (!exchanged) return NextResponse.json({ error: "Google sign-in could not be verified. Please try again.", requestId }, { status: 401, headers: { "x-request-id": requestId } });

    const user = await prisma.user.findUnique({ where: { id: exchanged.userId }, select: { id: true, mustChangePassword: true } });
    const role = await getUserRole(exchanged.userId, exchanged.workspaceId);
    if (!user || user.mustChangePassword || !role) {
      return NextResponse.json({ error: "account has no eligible workspace membership", requestId }, { status: 403, headers: { "x-request-id": requestId } });
    }

    const context = contextFromRequest(request);
    const session = await createApiToken(user.id, { userAgent: context.userAgent, label: "Extension sign-in" });
    const entitlements = await getEntitlements(exchanged.workspaceId);
    return NextResponse.json(
      { accessToken: session.token, expiresAt: session.expiresAt, accountId: user.id, workspaceId: exchanged.workspaceId, plan: entitlements.plan, role },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
