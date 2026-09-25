import { NextResponse } from "next/server";
import { authenticateCredentials } from "@/lib/accounts";
import { createApiToken } from "@/lib/apiTokens";
import { contextFromRequest } from "@/lib/requestContext";
import { getUserDefaultWorkspaceId, getUserRole } from "@/lib/workspaces";
import { ManagedValidationError, readManagedJson } from "@/lib/managedJobs";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getEntitlements } from "@/lib/usageLedger";
import { managedHostingEnabled } from "@/lib/managedAuth";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    const email = typeof value.email === "string" ? value.email.trim() : "";
    const password = typeof value.password === "string" ? value.password : "";
    if (!email || email.length > 320 || !password) throw new ManagedValidationError("email and password are required");

    const context = contextFromRequest(request);
    const result = await authenticateCredentials({ email, password, ip: context.ip });
    if (!result.ok) {
      return NextResponse.json({ error: "invalid credentials" }, { status: 401, headers: { "x-request-id": requestId } });
    }
    const user = result.user;
    if (user.mustChangePassword) return NextResponse.json({ error: "Change your temporary password in the web app before connecting the extension." }, { status: 403 });

    const workspaceId = await getUserDefaultWorkspaceId(user.id);
    if (!workspaceId) return NextResponse.json({ error: "account has no workspace" }, { status: 403, headers: { "x-request-id": requestId } });
    const role = await getUserRole(user.id, workspaceId);
    if (!role) return NextResponse.json({ error: "account has no workspace membership" }, { status: 403, headers: { "x-request-id": requestId } });
    const session = await createApiToken(user.id, { userAgent: context.userAgent, label: "Extension sign-in" });
    const entitlements = await getEntitlements(workspaceId);
    return NextResponse.json(
      { accessToken: session.token, expiresAt: session.expiresAt, accountId: user.id, workspaceId, plan: entitlements.plan, role },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
