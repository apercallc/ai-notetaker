/**
 * Cloud sync and team sync are the paid subscription. A workspace may sync only
 * while it holds an active Pro or Team subscription (or is inside the payment
 * grace window). The retired "hosted_trial" plan never grants sync. Dependency-free
 * so route handlers and the entitlements payload share one definition.
 */
export const SYNC_PLANS: ReadonlySet<string> = new Set(["hosted_pro", "hosted_team"]);

export const SYNC_SUBSCRIPTION_REQUIRED_MESSAGE =
  "Cloud sync needs an active AI Notetaker subscription. Your notes stay safe on this device.";

export type SyncSubscriptionLike = {
  plan: string;
  status: string;
  graceEndsAt: Date | null;
} | null | undefined;

export function hasSyncAccess(subscription: SyncSubscriptionLike, now = new Date()): boolean {
  if (!subscription || !SYNC_PLANS.has(subscription.plan)) return false;
  if (subscription.status === "active" || subscription.status === "trialing") return true;
  return subscription.status === "past_due" && Boolean(subscription.graceEndsAt && subscription.graceEndsAt >= now);
}
