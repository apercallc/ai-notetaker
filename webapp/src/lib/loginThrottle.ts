import { prisma } from "@/lib/db";

/**
 * Throttles repeated failed sign-in attempts in Postgres rather than process
 * memory. Managed hosting can therefore run multiple web replicas and a
 * redeploy cannot reset every address's failed-login budget.
 *
 * The key is the normalized submitted email, not a claimed client IP. Proxy
 * headers are not a trustworthy identity signal and an IP-only budget would
 * let attackers reset their own counter or lock out another user.
 */

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function normalize(email: string): string {
  return email.trim().toLocaleLowerCase();
}

/** True when this email has burned through its attempt budget. */
export async function isLoginThrottled(email: string, now: number = Date.now()): Promise<boolean> {
  const row = await prisma.loginThrottle.findUnique({ where: { emailKey: normalize(email) } });
  if (!row) return false;
  return row.firstFailureAt.getTime() > now - WINDOW_MS && row.failures >= MAX_FAILURES;
}

/**
 * Atomically increments the active window. The cleanup is deliberately a
 * bounded, indexed delete so cycling through invented addresses cannot leave
 * an unbounded table behind. The `ON CONFLICT` update is the important part:
 * concurrent requests on different web replicas serialize on the primary key
 * and cannot lose increments.
 */
export async function recordLoginFailure(email: string, now: number = Date.now()): Promise<void> {
  const key = normalize(email);
  const timestamp = new Date(now);
  const expiredBefore = new Date(now - WINDOW_MS);

  await prisma.loginThrottle.deleteMany({ where: { firstFailureAt: { lte: expiredBefore } } });
  await prisma.$executeRaw`
    INSERT INTO "LoginThrottle" ("emailKey", "failures", "firstFailureAt", "updatedAt")
    VALUES (${key}, 1, ${timestamp}, ${timestamp})
    ON CONFLICT ("emailKey") DO UPDATE
    SET "failures" = "LoginThrottle"."failures" + 1,
        "updatedAt" = ${timestamp}
  `;
}

/** A correct password clears the budget immediately. */
export async function clearLoginFailures(email: string): Promise<void> {
  await prisma.loginThrottle.deleteMany({ where: { emailKey: normalize(email) } });
}
