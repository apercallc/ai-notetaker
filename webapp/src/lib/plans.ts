/**
 * Plan identifiers are stored in the database as snake_case ids. Everything
 * user-facing goes through this module so ids like "hosted_pro" never leak
 * into the UI. Dependency-free on purpose: safe to import from client
 * components and from the extension-facing entitlements payload.
 */
export type ManagedPlan = "local" | "hosted_trial" | "hosted_pro" | "hosted_team";

export const HOSTED_TRIAL_MEETINGS = 3;

export const PLAN_MEETING_LIMITS: Record<ManagedPlan, number> = {
  local: 0,
  hosted_trial: HOSTED_TRIAL_MEETINGS,
  hosted_pro: 300,
  hosted_team: 2_500,
};

/**
 * Monthly audio-hours cap per plan. Meetings are cheap on average (about $0.09
 * of provider cost per two-channel hour on the Groq default), but the meeting
 * count alone let one workspace burn far more than its subscription pays, so
 * hours bound the worst case. Trial is a one-time grant.
 */
export const PLAN_AUDIO_HOUR_LIMITS: Record<ManagedPlan, number> = {
  local: 0,
  hosted_trial: 3,
  hosted_pro: 60,
  hosted_team: 200,
};

/** Two channels of 48 kHz 16-bit mono PCM; a one-channel upload counts as half. */
export const AUDIO_BYTES_PER_SECOND = 2 * 48_000 * 2;

export function audioSecondsForBytes(bytes: number): number {
  return Math.ceil(bytes / AUDIO_BYTES_PER_SECOND);
}

const PLAN_LABELS: Record<ManagedPlan, string> = {
  local: "Local (bring your own keys)",
  hosted_trial: "Hosted Free Trial",
  hosted_pro: "Hosted Pro",
  hosted_team: "Hosted Team",
};

export function isManagedPlan(value: string): value is ManagedPlan {
  return Object.prototype.hasOwnProperty.call(PLAN_LABELS, value);
}

export function planLabel(plan: string): string {
  return isManagedPlan(plan) ? PLAN_LABELS[plan] : plan.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human wording for a Stripe subscription status. */
export function statusLabel(status: string): string {
  switch (status) {
    case "active": return "Active";
    case "trialing": return "Trial";
    case "past_due": return "Payment past due";
    case "canceled": return "Canceled";
    case "unpaid": return "Unpaid";
    case "incomplete": return "Awaiting payment";
    case "incomplete_expired": return "Expired";
    case "paused": return "Paused";
    case "inactive": return "No subscription";
    default: return status.replace(/_/g, " ");
  }
}
