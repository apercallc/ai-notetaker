import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { prisma } from "@/lib/db";
import { getEntitlements } from "@/lib/usageLedger";
import { getChatEntitlement } from "@/lib/chatQuota";
import { getPlanCatalog, hasLiveSubscription } from "@/lib/billing";
import { PLAN_AUDIO_HOUR_LIMITS, statusLabel } from "@/lib/plans";

/**
 * Everything the desktop Account screen shows, in one call: who is signed in, the
 * plan, meeting / audio-hour / question usage, and what the owner can buy or manage.
 * It mirrors the web Billing page so both surfaces always agree.
 */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const [entitlements, chat, subscription, workspace, catalog] = await Promise.all([
      getEntitlements(session.workspaceId),
      getChatEntitlement(session.workspaceId),
      prisma.workspaceSubscription.findUnique({ where: { workspaceId: session.workspaceId } }),
      prisma.workspace.findUnique({ where: { id: session.workspaceId }, select: { name: true } }),
      getPlanCatalog().catch(() => []),
    ]);
    const live = hasLiveSubscription(subscription);
    return NextResponse.json(
      {
        account: { email: session.email, role: session.role },
        workspace: { id: session.workspaceId, name: workspace?.name ?? "Workspace" },
        entitlements,
        chat,
        statusLabel: statusLabel(entitlements.status),
        audioHourLimit: PLAN_AUDIO_HOUR_LIMITS[entitlements.plan],
        subscription: {
          live,
          hasBillingAccount: Boolean(subscription?.stripeCustomerId),
          cancelsAt: live ? subscription?.cancelsAt?.toISOString() ?? null : null,
        },
        // Only the owner can buy or manage a plan; members see usage read-only.
        offers: session.role === "owner" ? catalog.map(({ id, name, priceId, meetingLimit, priceLabel, yearly }) => ({ id, name, priceId, meetingLimit, priceLabel, yearly })) : [],
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
