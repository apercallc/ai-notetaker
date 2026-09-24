import { prisma } from "./db";

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3_650;

export async function getDefaultWorkspaceId(): Promise<string> {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { isDefault: true } });
  return workspace.id;
}

/**
 * Attaches the self-hosted bootstrap user to the deployment's pre-created
 * default workspace. Managed hosting uses createHostedWorkspaceWithOwner so
 * every signup receives an independent tenant instead.
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

/** Creates an independent tenant for project-operated managed hosting. The
 * self-hosted bootstrap path deliberately continues to attach its first user
 * to the pre-created default workspace. */
export async function createHostedWorkspaceWithOwner(
  email: string,
  passwordHash: string,
  workspaceName: string,
): Promise<{ userId: string; workspaceId: string }> {
  const user = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name: workspaceName, isDefault: false } });
    const created = await tx.user.create({ data: { email, passwordHash } });
    await tx.workspaceMembership.create({
      data: { userId: created.id, workspaceId: workspace.id, role: "owner" },
    });
    return { userId: created.id, workspaceId: workspace.id };
  });
  return user;
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

export async function updateWorkspaceRetentionDays(workspaceId: string, retentionDays: number | null): Promise<void> {
  if (retentionDays !== null && (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS)) {
    throw new Error(`retention must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days, or disabled`);
  }
  await prisma.workspace.update({ where: { id: workspaceId }, data: { retentionDays } });
}
