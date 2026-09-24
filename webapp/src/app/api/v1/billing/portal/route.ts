import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { BillingError, createPortalSession } from "@/lib/billing";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session || session.role !== "owner") return managedUnauthorized(requestId);
  try {
    const returnUrl = request.headers.get("origin");
    if (!returnUrl?.startsWith("https://")) throw new BillingError("a secure return origin is required");
    return NextResponse.json({ url: await createPortalSession(session.workspaceId, returnUrl) }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
