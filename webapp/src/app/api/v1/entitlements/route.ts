import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { getEntitlements } from "@/lib/usageLedger";

/** Returns the server-authoritative plan/quota before a client starts capture. */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const entitlements = await getEntitlements(session.workspaceId);
    return NextResponse.json(entitlements, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
