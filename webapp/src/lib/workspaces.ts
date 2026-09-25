import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { normalizeEmail } from "./email";
import { assignHostedTrial } from "./usageLedger";

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3_650;

export async function getDefaultWorkspaceId(): Promise<string> {
  // orderBy makes "the" default deterministic even if a bad import ever
  // leaves more than one row flagged.
  const workspace = await prisma.workspace.findFirstOrThrow({
    where: { isDefault: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
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
    // The deploy-time setup code already proved the operator owns this
    // instance, so the bootstrap account starts verified.
    const created = await tx.user.create({ data: { email: normalizeEmail(email), passwordHash, emailVerifiedAt: new Date() } });
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
  options: { termsAcceptedAt?: Date; termsVersion?: string; emailVerifiedAt?: Date | null } = {},
): Promise<{ userId: string; workspaceId: string }> {
  const user = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name: workspaceName, isDefault: false } });
    const created = await tx.user.create({
      data: {
        email: normalizeEmail(email),
        passwordHash,
        termsAcceptedAt: options.termsAcceptedAt ?? null,
        termsVersion: options.termsVersion ?? null,
        emailVerifiedAt: options.emailVerifiedAt ?? null,
      },
    });
    await tx.workspaceMembership.create({
      data: { userId: created.id, workspaceId: workspace.id, role: "owner" },
    });
    // Every hosted workspace starts with the no-card trial allowance so
    // signup is never a dead end before the owner picks a paid plan.
    await assignHostedTrial(tx, workspace.id);
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
  options: { mustChangePassword?: boolean } = {},
): Promise<{ userId: string }> {
  const user = await prisma.$transaction(async (tx) => {
    // An owner typed this address and hands over the credential, so the
    // account counts as owner-provisioned (verified). A temporary password
    // must be replaced at first sign-in.
    const created = await tx.user.create({
      data: {
        email: normalizeEmail(email),
        passwordHash,
        emailVerifiedAt: new Date(),
        mustChangePassword: options.mustChangePassword ?? false,
      },
    });
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
  // Oldest membership first, id as tiebreaker: a user in several workspaces
  // always lands in the same one until they pick another.
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return membership?.workspaceId ?? null;
}

/**
 * The workspace a session should operate in: the one picked in the switcher
 * if the user is STILL a member of it, otherwise the deterministic default.
 * Membership is re-checked every time, so a removed member's stale
 * `activeWorkspaceId` can never grant access.
 */
export async function resolveActiveWorkspace(
  userId: string,
  preferredWorkspaceId?: string | null,
): Promise<{ workspaceId: string; role: "owner" | "member" } | null> {
  if (preferredWorkspaceId) {
    const role = await getUserRole(userId, preferredWorkspaceId);
    if (role) return { workspaceId: preferredWorkspaceId, role };
  }
  const workspaceId = await getUserDefaultWorkspaceId(userId);
  if (!workspaceId) return null;
  const role = await getUserRole(userId, workspaceId);
  return role ? { workspaceId, role } : null;
}

export async function listUserWorkspaces(userId: string): Promise<Array<{ id: string; name: string; role: "owner" | "member" }>> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { workspace: { select: { id: true, name: true } } },
  });
  return memberships.map((membership) => ({
    id: membership.workspace.id,
    name: membership.workspace.name,
    role: membership.role as "owner" | "member",
  }));
}

export async function updateWorkspaceRetentionDays(workspaceId: string, retentionDays: number | null): Promise<void> {
  if (retentionDays !== null && (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS)) {
    throw new Error(`retention must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days, or disabled`);
  }
  await prisma.workspace.update({ where: { id: workspaceId }, data: { retentionDays } });
}

export type MembershipChangeResult = { ok: true } | { ok: false; reason: "not-found" | "last-owner" | "self" };

/** Locks a workspace's owner rows so concurrent demotions cannot both pass the last-owner check. */
async function lockOwners(tx: Prisma.TransactionClient, workspaceId: string): Promise<number> {
  const owners = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "WorkspaceMembership" WHERE "workspaceId" = ${workspaceId} AND "role" = 'owner' FOR UPDATE
  `;
  return owners.length;
}

/**
 * Changes a member's role. The membership must belong to `workspaceId` — the
 * caller's own workspace — so an owner can never touch another tenant's rows
 * by guessing a membership id. A workspace can never lose its last owner.
 */
export async function changeMemberRole(
  workspaceId: string,
  membershipId: string,
  role: "owner" | "member",
): Promise<MembershipChangeResult> {
  return prisma.$transaction(async (tx) => {
    const ownerCount = await lockOwners(tx, workspaceId);
    const membership = await tx.workspaceMembership.findFirst({ where: { id: membershipId, workspaceId } });
    if (!membership) return { ok: false, reason: "not-found" } as const;
    if (membership.role === role) return { ok: true } as const;
    if (membership.role === "owner" && role === "member" && ownerCount <= 1) return { ok: false, reason: "last-owner" } as const;
    await tx.workspaceMembership.update({ where: { id: membership.id }, data: { role } });
    return { ok: true } as const;
  });
}

/**
 * Removes a member from a workspace. Their sessions stop pointing at it, and
 * an account left with no workspace at all is deleted (it could never sign in
 * again and would squat the address). Meetings stay with the workspace.
 */
export async function removeWorkspaceMember(
  workspaceId: string,
  membershipId: string,
): Promise<MembershipChangeResult & { removedUserId?: string; accountDeleted?: boolean }> {
  return prisma.$transaction(async (tx) => {
    const ownerCount = await lockOwners(tx, workspaceId);
    const membership = await tx.workspaceMembership.findFirst({ where: { id: membershipId, workspaceId } });
    if (!membership) return { ok: false, reason: "not-found" } as const;
    if (membership.role === "owner" && ownerCount <= 1) return { ok: false, reason: "last-owner" } as const;

    await tx.workspaceMembership.delete({ where: { id: membership.id } });
    await tx.session.updateMany({
      where: { userId: membership.userId, activeWorkspaceId: workspaceId },
      data: { activeWorkspaceId: null },
    });
    const remaining = await tx.workspaceMembership.count({ where: { userId: membership.userId } });
    if (remaining === 0) {
      await tx.user.delete({ where: { id: membership.userId } });
      return { ok: true, removedUserId: membership.userId, accountDeleted: true } as const;
    }
    return { ok: true, removedUserId: membership.userId, accountDeleted: false } as const;
  });
}

export async function getWorkspaceMembership(workspaceId: string, membershipId: string) {
  return prisma.workspaceMembership.findFirst({
    where: { id: membershipId, workspaceId },
    include: { user: { select: { id: true, email: true } } },
  });
}

/** True when the user has no membership outside `workspaceId`. */
export async function userBelongsOnlyTo(userId: string, workspaceId: string): Promise<boolean> {
  return (await prisma.workspaceMembership.count({ where: { userId, workspaceId: { not: workspaceId } } })) === 0;
}

export type InviteAcceptResult =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; reason: "already-member" | "email-mismatch" | "workspace-gone" };

/** Adds an EXISTING user to the workspace named by a consumed invite. */
export async function joinWorkspaceFromInvite(
  userId: string,
  userEmail: string,
  invite: { email: string; workspaceId: string; role: string | null },
): Promise<InviteAcceptResult> {
  if (normalizeEmail(userEmail) !== normalizeEmail(invite.email)) return { ok: false, reason: "email-mismatch" };
  const workspace = await prisma.workspace.findUnique({ where: { id: invite.workspaceId }, select: { id: true } });
  if (!workspace) return { ok: false, reason: "workspace-gone" };
  const role = invite.role === "owner" ? "owner" : "member";
  try {
    await prisma.workspaceMembership.create({ data: { userId, workspaceId: invite.workspaceId, role } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { ok: false, reason: "already-member" };
    throw error;
  }
  return { ok: true, userId, workspaceId: invite.workspaceId };
}

/** Creates the account for an invitee who has none; the invite link proves the mailbox. */
export async function createUserFromInvite(
  invite: { email: string; workspaceId: string; role: string | null },
  passwordHash: string,
  terms: { termsAcceptedAt: Date; termsVersion: string },
): Promise<{ userId: string; workspaceId: string }> {
  const role = invite.role === "owner" ? "owner" : "member";
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUnique({ where: { id: invite.workspaceId }, select: { id: true } });
    if (!workspace) throw new Error("workspace no longer exists");
    const created = await tx.user.create({
      data: { email: normalizeEmail(invite.email), passwordHash, emailVerifiedAt: new Date(), ...terms },
    });
    await tx.workspaceMembership.create({ data: { userId: created.id, workspaceId: invite.workspaceId, role } });
    return { userId: created.id, workspaceId: invite.workspaceId };
  });
}
