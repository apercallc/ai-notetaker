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

export const ENTITLEMENT_PUBLIC_MESSAGE = "Your plan has no hosted processing left. Upgrade under Plans & usage to keep processing meetings.";
