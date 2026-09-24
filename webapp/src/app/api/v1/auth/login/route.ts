import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/passwords";
import { createSession } from "@/lib/sessions";
import { getUserDefaultWorkspaceId, getUserRole } from "@/lib/workspaces";
import { ManagedValidationError, readManagedJson } from "@/lib/managedJobs";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getEntitlements } from "@/lib/usageLedger";
import { clearLoginFailures, isLoginThrottled, recordLoginFailure } from "@/lib/loginThrottle";
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

    if (await isLoginThrottled(email)) {
      return NextResponse.json({ error: "invalid credentials" }, { status: 401, headers: { "x-request-id": requestId } });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !valid) {
      await recordLoginFailure(email);
      return NextResponse.json({ error: "invalid credentials" }, { status: 401, headers: { "x-request-id": requestId } });
    }

    const workspaceId = await getUserDefaultWorkspaceId(user.id);
    if (!workspaceId) return NextResponse.json({ error: "account has no workspace" }, { status: 403, headers: { "x-request-id": requestId } });
    const role = await getUserRole(user.id, workspaceId);
    if (!role) return NextResponse.json({ error: "account has no workspace membership" }, { status: 403, headers: { "x-request-id": requestId } });
    await clearLoginFailures(email);
    const session = await createSession(user.id);
    const entitlements = await getEntitlements(workspaceId);
    return NextResponse.json(
      { accessToken: session.id, expiresAt: session.expiresAt, accountId: user.id, workspaceId, plan: entitlements.plan, role },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
