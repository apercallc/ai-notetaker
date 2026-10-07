import { prisma } from "./db";
import { hasSyncAccess } from "./syncAccess";

export const TEAM_PLAN_REQUIRED_MESSAGE = "Inviting teammates needs the Team plan. Choose Team under Plan to add people to this workspace.";

/**
 * Team features (inviting members, retention, the activity log) are the Team plan. Pro is one
 * person syncing their own devices. A deployment without managed hosting has no billing, so it
 * keeps every team feature.
 */
export async function teamPlanActive(workspaceId: string): Promise<boolean> {
  if (process.env.MANAGED_HOSTING !== "true") return true;
  const subscription = await prisma.workspaceSubscription.findUnique({
    where: { workspaceId },
    select: { plan: true, status: true, graceEndsAt: true },
  });
  return subscription?.plan === "hosted_team" && hasSyncAccess(subscription);
}
