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
