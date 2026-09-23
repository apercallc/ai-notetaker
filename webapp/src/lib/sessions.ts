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
  if (session.expiresAt.getTime() < Date.now()) return null;
  return { id: session.user.id, email: session.user.email };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}
