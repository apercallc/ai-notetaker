import { prisma } from "./db";

export async function getDefaultWorkspaceId(): Promise<string> {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { isDefault: true } });
  return workspace.id;
}

/**
 * Attaches a brand-new user to the deployment's single default workspace
 * as its owner. This project supports exactly one workspace per
 * deployment (see the design spec's non-goals) — there is deliberately
 * no "create a new workspace" path.
 */
export async function createWorkspaceWithOwner(
  email: string,
  passwordHash: string,
): Promise<{ userId: string; workspaceId: string }> {
  const workspaceId = await getDefaultWorkspaceId();
  const user = await prisma.user.create({ data: { email, passwordHash } });
  await prisma.workspaceMembership.create({
    data: { userId: user.id, workspaceId, role: "owner" },
  });
  return { userId: user.id, workspaceId };
}

export async function addWorkspaceMember(
  workspaceId: string,
  email: string,
  passwordHash: string,
): Promise<{ userId: string }> {
  const user = await prisma.user.create({ data: { email, passwordHash } });
  await prisma.workspaceMembership.create({
    data: { userId: user.id, workspaceId, role: "member" },
  });
  return { userId: user.id };
}

export async function getUserRole(userId: string, workspaceId: string): Promise<"owner" | "member" | null> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return (membership?.role as "owner" | "member" | undefined) ?? null;
}

export async function getUserDefaultWorkspaceId(userId: string): Promise<string | null> {
  const membership = await prisma.workspaceMembership.findFirst({ where: { userId } });
  return membership?.workspaceId ?? null;
}
