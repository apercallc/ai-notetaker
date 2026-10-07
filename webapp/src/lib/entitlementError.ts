/**
 * The workspace's plan has no hosted processing available (trial used up,
 * plan lapsed, or limit reached). A user-facing 402, never a 500: the client
 * should show an upgrade prompt, and it is not worth a Sentry event.
 * The message text is matched by existing callers, so keep it stable.
 */
export class EntitlementError extends Error {
  constructor(message = "managed processing entitlement is unavailable") {
    super(message);
    this.name = "EntitlementError";
  }
}

/** Hosted processing is switched off for the whole service (see hostedAiEnabled). */
export class HostedAiDisabledError extends EntitlementError {
  constructor() {
    super("hosted AI processing is not offered");
    this.name = "HostedAiDisabledError";
  }
}

/** The workspace's monthly audio hours cannot cover this recording. Same 402 as any entitlement failure. */
export class AudioBudgetError extends EntitlementError {
  constructor() {
    super("managed audio hours are exhausted");
    this.name = "AudioBudgetError";
  }
}

export const AUDIO_BUDGET_PUBLIC_MESSAGE = "This recording is longer than the hosted meeting hours left in your plan. Upgrade under Plan, or wait for the next period.";

export const HOSTED_AI_DISABLED_PUBLIC_MESSAGE = "Hosted processing isn't offered. Your recording stays on this device. Use the desktop app with your own provider keys.";

export const ENTITLEMENT_PUBLIC_MESSAGE = "Your plan has no hosted processing left. Upgrade under Plan to keep processing meetings.";
