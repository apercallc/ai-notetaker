import { prisma } from "./db";
import { SYNC_PLANS, hasSyncAccess, type SyncSubscriptionLike } from "./syncAccess";

/**
 * What a workspace may do once its plan is no longer active.
 *
 * Cancelling never deletes or locks anyone's notes. A workspace without an active plan is
 * READ-ONLY: its notes stay readable, searchable, exportable and deletable, and can still be
 * downloaded to a desktop app. Only the paid features stop: uploading and syncing new notes,
 * editing, new shares, new integrations and inviting people. Resubscribing restores everything.
 */
export interface WorkspaceAccess {
  /** An active plan (or its payment grace window): sync, editing and sharing are on. */
  writable: boolean;
  /** The workspace had a plan (or a trial) once and it is no longer active. */
  lapsed: boolean;
}

export type AccessSubscription = (SyncSubscriptionLike & { stripeSubscriptionId?: string | null; stripeCustomerId?: string | null }) | null | undefined;

export function accessFromSubscription(subscription: AccessSubscription, now = new Date()): WorkspaceAccess {
  if (hasSyncAccess(subscription, now)) return { writable: true, lapsed: false };
  const everPaid =
    Boolean(subscription?.stripeSubscriptionId) ||
    Boolean(subscription?.stripeCustomerId) ||
    (subscription !== null && subscription !== undefined && (SYNC_PLANS.has(subscription.plan) || subscription.plan === "hosted_trial"));
  return { writable: false, lapsed: everPaid };
}

export const LAPSED_READ_ONLY_MESSAGE =
  "Your plan has ended, so this library is read-only. You can still read, search and export every note, or choose a plan to edit and sync again.";
export const NO_PLAN_MESSAGE = "The cloud library needs a Pro or Team plan. Your notes stay on your device.";

export function writeBlockedMessage(access: WorkspaceAccess): string | null {
  if (access.writable) return null;
  return access.lapsed ? LAPSED_READ_ONLY_MESSAGE : NO_PLAN_MESSAGE;
}

/** A deployment without managed hosting has no billing, so nothing is ever read-only there. */
export async function getWorkspaceAccess(workspaceId: string): Promise<WorkspaceAccess> {
  if (process.env.MANAGED_HOSTING !== "true") return { writable: true, lapsed: false };
  const subscription = await prisma.workspaceSubscription.findUnique({
    where: { workspaceId },
    select: { plan: true, status: true, graceEndsAt: true, stripeSubscriptionId: true, stripeCustomerId: true },
  });
  return accessFromSubscription(subscription);
}

/** The refusal to show for a content write, or null when the workspace may write. */
export async function writeBlock(workspaceId: string): Promise<string | null> {
  return writeBlockedMessage(await getWorkspaceAccess(workspaceId));
}
