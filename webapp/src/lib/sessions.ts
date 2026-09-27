import { prisma } from "./db";
import { looksLikeApiToken, resolveApiToken } from "./apiTokens";

export const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, matches the previous cookie maxAge
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionMetadata {
  userAgent?: string | null;
  ip?: string | null;
  activeWorkspaceId?: string | null;
}

export async function createSession(
  userId: string,
  metadata: SessionMetadata = {},
): Promise<{ id: string; expiresAt: Date }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt,
      lastUsedAt: now,
      userAgent: metadata.userAgent?.slice(0, 300) ?? null,
      ip: metadata.ip?.slice(0, 64) ?? null,
      activeWorkspaceId: metadata.activeWorkspaceId ?? null,
    },
  });
  return { id: session.id, expiresAt: session.expiresAt };
}

export interface SessionContext {
  sessionId: string;
  user: { id: string; email: string; mustChangePassword: boolean };
  activeWorkspaceId: string | null;
}

/**
 * Resolves a BROWSER cookie value only. Extension API tokens are deliberately
 * not accepted here: they are scoped to the managed API, so one pasted into a
 * cookie must not unlock the web UI.
 */
export async function getSessionContext(sessionId: string | undefined, now: number = Date.now()): Promise<SessionContext | null> {
  if (!sessionId || looksLikeApiToken(sessionId)) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { id: true, email: true, mustChangePassword: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < now) {
    // Nothing else ever deletes these. Rows are only removed on an explicit
    // sign-out, so every session a user simply abandons — a closed laptop, a
    // cleared cookie jar, a new browser — stays in the table forever. Reaping
    // the one we just proved dead costs a single delete on a path that
    // already did a lookup, and needs no cron or new infrastructure.
    await deleteSession(session.id);
    return null;
  }
  // Record "last active" for the devices list, at most every few minutes so a
  // page load stays read-only almost always.
  if (!session.lastUsedAt || session.lastUsedAt.getTime() < now - TOUCH_INTERVAL_MS) {
    await prisma.session.updateMany({ where: { id: session.id }, data: { lastUsedAt: new Date(now) } });
  }
  return { sessionId: session.id, user: session.user, activeWorkspaceId: session.activeWorkspaceId };
}

/**
 * Resolves either kind of credential to a user: a browser session id (cookie)
 * or an `ant_…` hashed API token (Authorization: Bearer). Kept as one entry
 * point because the proxy and the managed-API session helper both call it with
 * whatever credential the request carried.
 */
export async function getSessionUser(
  sessionId: string | undefined,
): Promise<{ id: string; email: string } | null> {
  if (!sessionId) return null;
  if (looksLikeApiToken(sessionId)) {
    const token = await resolveApiToken(sessionId);
    return token ? { id: token.id, email: token.email } : null;
  }
  const context = await getSessionContext(sessionId);
  return context ? { id: context.user.id, email: context.user.email } : null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

/** Signs a user out everywhere, optionally keeping the session making the request. */
export async function deleteUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
  return result.count;
}

/** Revokes a single session, only if it belongs to `userId`. */
export async function revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
  return (await prisma.session.deleteMany({ where: { id: sessionId, userId } })).count > 0;
}

export async function listUserSessions(userId: string, now: number = Date.now()) {
  return prisma.session.findMany({
    where: { userId, expiresAt: { gt: new Date(now) } },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }],
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true, activeWorkspaceId: true },
  });
}

/** Remembers the workspace picked in the switcher. Caller must have verified membership. */
export async function setSessionActiveWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
  await prisma.session.updateMany({ where: { id: sessionId }, data: { activeWorkspaceId: workspaceId } });
}

/**
 * Housekeeping on sign-in: drop every expired browser session, API token and
 * spent/expired auth token. All three are indexed on expiry, so this is a
 * cheap bounded delete that needs no cron.
 */
export async function cleanupExpiredAuth(now: number = Date.now()): Promise<void> {
  const cutoff = new Date(now);
  await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.apiToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } } }),
  ]);
}

/** Human-readable device label from a user-agent string. */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 40);
}
