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
/**
 * The user row and its membership are created in one transaction on purpose.
 * Created separately, a failure between them leaves a User with no
 * membership — and that user is not merely broken but unrecoverable:
 * `requireSession` bounces them to /login for having no workspace, while
 * `bootstrap`'s `hasAnyUser()` check now sees an account and refuses to let
 * anyone claim the instance. The deployment is permanently locked out with
 * no UI to fix it.
 */
export async function createWorkspaceWithOwner(
  email: string,
  passwordHash: string,
): Promise<{ userId: string; workspaceId: string }> {
  const workspaceId = await getDefaultWorkspaceId();
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { email, passwordHash } });
    await tx.workspaceMembership.create({
      data: { userId: created.id, workspaceId, role: "owner" },
    });
    return created;
  });
  return { userId: user.id, workspaceId };
}

/** Same all-or-nothing reasoning as createWorkspaceWithOwner: a member row
 * without a membership can never sign in and can never be cleaned up from
 * the UI, but does permanently occupy its email address. */
export async function addWorkspaceMember(
  workspaceId: string,
  email: string,
  passwordHash: string,
): Promise<{ userId: string }> {
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { email, passwordHash } });
    await tx.workspaceMembership.create({
      data: { userId: created.id, workspaceId, role: "member" },
    });
    return created;
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
