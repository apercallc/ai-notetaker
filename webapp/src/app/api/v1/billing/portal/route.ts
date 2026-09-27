import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { BillingError, createPortalSession } from "@/lib/billing";
import { DeploymentConfigError, getAppUrl } from "@/lib/deploymentConfig";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session || session.role !== "owner") return managedUnauthorized(requestId);
  try {
    // The return URL is this deployment's own configured origin, never the
    // caller-supplied Origin header.
    let returnUrl: string;
    try {
      returnUrl = `${getAppUrl()}/billing`;
    } catch (error) {
      if (error instanceof DeploymentConfigError) throw new BillingError("Billing is unavailable: APP_URL is not configured on this server");
      throw error;
    }
    return NextResponse.json({ url: await createPortalSession(session.workspaceId, returnUrl) }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
