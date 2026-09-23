import { timingSafeEqual } from "node:crypto";

/**
 * v1 has no real multi-user concept — every row is written/read under this
 * single constant userId. The schema already carries userId/workspaceId on
 * every table (see prisma/schema.prisma) so a future multi-user auth model
 * doesn't require a migration, but nothing else acts on it yet.
 */
export const LOCAL_USER_ID = "local";

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers of different length must still be compared against something of
  // matching length, or timingSafeEqual throws — hash-pad instead of
  // short-circuiting on length, to avoid leaking length via timing.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Every route in this app requires the deploy-time AUTH_TOKEN, including
 * reads — there is no "public by default" route (the one exception, the
 * health check, never calls this function at all). Fails closed: an unset
 * or empty AUTH_TOKEN environment variable means every request is rejected,
 * never treated as "auth disabled."
 */
export function isAuthorizedBearer(authorizationHeader: string | null): boolean {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return false;

  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const provided = authorizationHeader.slice("Bearer ".length);
  if (!provided) return false;

  return constantTimeEquals(provided, expected);
}

/**
 * Gates the one-time "create the first account" bootstrap flow
 * (src/app/login/actions.ts's bootstrap()) behind the same deploy-time
 * secret as everything else. Without this, the first anonymous visitor
 * to reach a freshly deployed instance's public URL — not necessarily
 * its owner — could claim the owning account with an arbitrary email/
 * password and no secret knowledge at all, a real regression from the
 * old AUTH_TOKEN-gated single session (found in guardrails review).
 * Reuses the exact fail-closed, constant-time comparison as
 * isAuthorizedBearer — same secret, different presentation (a form
 * field here instead of a header).
 */
export function isValidSetupToken(provided: string | null | undefined): boolean {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return false;
  if (!provided) return false;

  return constantTimeEquals(provided, expected);
}
