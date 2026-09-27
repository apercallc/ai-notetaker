import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { readManagedJson } from "@/lib/managedJobs";
import { BillingError, BillingPortalRequiredError, createCheckoutSession } from "@/lib/billing";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session || session.role !== "owner") return managedUnauthorized(requestId);
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new BillingError("request body must be an object");
    const value = body as Record<string, unknown>;
    const priceId = typeof value.priceId === "string" ? value.priceId : "";
    const successUrl = typeof value.successUrl === "string" ? value.successUrl : "";
    const cancelUrl = typeof value.cancelUrl === "string" ? value.cancelUrl : "";
    if (!successUrl.startsWith("https://") || !cancelUrl.startsWith("https://")) throw new BillingError("success and cancel URLs must use HTTPS");
    const url = await createCheckoutSession(session.workspaceId, session.email, priceId, successUrl, cancelUrl);
    return NextResponse.json({ url }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof BillingPortalRequiredError) {
      // A live subscription already exists: the client must manage it in the portal.
      return NextResponse.json({ error: error.message, portalRequired: true }, { status: 409, headers: { "x-request-id": requestId } });
    }
    return apiErrorResponse(error, { requestId });
  }
}
