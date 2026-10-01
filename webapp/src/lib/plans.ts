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

/**
 * Monthly "Ask your notes" questions per plan. Chat is a paid-plan feature:
 * the free trial and local modes get none. Each question costs one bounded
 * provider call (see notesChat.ts), so the cap bounds worst-case spend.
 */
export const PLAN_CHAT_QUESTION_LIMITS: Record<ManagedPlan, number> = {
  local: 0,
  hosted_trial: 0,
  hosted_pro: 300,
  hosted_team: 2_000,
};

/**
 * Longest single imported recording per plan. Imports also draw from the same
 * monthly audio-hour cap as live meetings, so this only bounds one file.
 */
export const PLAN_IMPORT_MAX_SECONDS: Record<ManagedPlan, number> = {
  local: 0,
  hosted_trial: 1 * 3_600,
  hosted_pro: 4 * 3_600,
  hosted_team: 6 * 3_600,
};

/** Assumed bitrate (128 kbit/s) when the browser cannot read a file's duration. */
const IMPORT_FALLBACK_BYTES_PER_SECOND = 16_000;
/**
 * A file cannot hold more audio than its size allows at lossless rates, so a
 * client claiming a tiny duration for a huge file still reserves a floor. The
 * worker's probe replaces the reservation with the real duration afterwards.
 */
const IMPORT_FLOOR_BYTES_PER_SECOND = 2_000_000;

/**
 * Audio seconds reserved when an import starts, before the worker has probed
 * the file. Imports are billed at full duration (one second of file is one
 * second of quota), unlike the two-channel-equivalent live-capture formula.
 */
export function estimateImportSeconds(totalBytes: number, declaredSeconds?: number | null): number {
  const floor = Math.max(1, Math.ceil(totalBytes / IMPORT_FLOOR_BYTES_PER_SECOND));
  const declared = typeof declaredSeconds === "number" && Number.isFinite(declaredSeconds) && declaredSeconds > 0
    ? Math.ceil(declaredSeconds)
    : Math.ceil(totalBytes / IMPORT_FALLBACK_BYTES_PER_SECOND);
  return Math.max(floor, declared);
}

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
