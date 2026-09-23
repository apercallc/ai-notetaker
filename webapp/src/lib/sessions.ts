import { prisma } from "./db";

const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, matches the previous cookie maxAge

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  return { id: session.id, expiresAt: session.expiresAt };
}

export async function getSessionUser(
  sessionId: string | undefined,
): Promise<{ id: string; email: string } | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Nothing else ever deletes these. Rows are only removed on an explicit
    // sign-out, so every session a user simply abandons — a closed laptop, a
    // cleared cookie jar, a new browser — stays in the table forever. Reaping
    // the one we just proved dead costs a single delete on a path that
    // already did a lookup, and needs no cron or new infrastructure.
    await deleteSession(session.id);
    return null;
  }
  return { id: session.user.id, email: session.user.email };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}
