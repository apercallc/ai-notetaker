import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hashPassword } from "@/lib/passwords";
import { addWorkspaceMember, changeMemberRole, removeWorkspaceMember, getWorkspaceMembership, userBelongsOnlyTo } from "@/lib/workspaces";
import { prisma } from "@/lib/db";
import { normalizeEmail, isPlausibleEmail } from "@/lib/email";
import { sendInviteEmail, sendPasswordResetEmail } from "@/lib/authEmails";
import type { RequestContext } from "@/lib/requestContext";
import { listPendingInvites, revokeInvites } from "@/lib/authTokens";
import { recordAudit } from "@/lib/audit";
import { emailRequestStatus, formatRetryAfter, recordEmailRequest } from "@/lib/loginThrottle";

/**
 * Workspace team management shared by the web pages (server actions) and the
 * desktop app (bearer API). Expected failures are returned, never thrown: a
 * thrown error reaches a web client as Next's masked message.
 */
export interface TeamSession {
  userId: string;
  email: string;
  workspaceId: string;
  role: "owner" | "member";
}

const MAX_INVITES_PER_OWNER_PER_DAY = 50;

export type AddMemberResult =
  | { ok: true; email: string; temporaryPassword: string }
  | { ok: false; error: string };

function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url"); // 16 chars, URL-safe, easy to read aloud/copy
}

export async function addMemberAs(session: TeamSession, rawEmail: string): Promise<AddMemberResult> {
  if (session.role !== "owner") {
    return { ok: false, error: "Only the workspace owner can add members." };
  }

  const email = normalizeEmail(rawEmail);
  if (!isPlausibleEmail(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  let added: Awaited<ReturnType<typeof addWorkspaceMember>>;
  try {
    added = await addWorkspaceMember(session.workspaceId, email, passwordHash, { mustChangePassword: true });
  } catch (error) {
    // P2002 is the unique constraint on User.email.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: "Could not add this address. Send an invitation instead." };
    }
    console.error("adding a workspace member failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Could not add that member. Try again." };
  }

  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "member.add", targetType: "user", targetId: added.userId, metadata: { email } });
  return { ok: true, email, temporaryPassword };
}

export type TeamActionResult = { ok: true; link?: string; message: string } | { ok: false; error: string };

export interface TeamOperation {
  operation: string;
  id: string;
  email: string;
  role: string;
}

export async function manageTeamAs(session: TeamSession, input: TeamOperation, getContext: () => Promise<RequestContext>): Promise<TeamActionResult> {
  try {
    return await run(session, input, getContext);
  } catch (error) {
    // An unexpected failure (database, mail transport) would otherwise reach the
    // client as a masked "server error" with no usable message.
    console.error("team management failed", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Something went wrong. Nothing was lost; try again in a moment." };
  }
}

async function run(session: TeamSession, input: TeamOperation, getContext: () => Promise<RequestContext>): Promise<TeamActionResult> {
  if (session.role !== "owner") return { ok: false, error: "Only owners can manage this workspace." };
  const { operation, id } = input;
  if (operation === "invite") {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email)) return { ok: false, error: "Enter a valid email address." };
    const context = await getContext();
    // Invitations send mail from our domain to an address the owner picks, so
    // cap them per recipient, per network address, and per owner per day.
    const throttle = await emailRequestStatus("invite", email, { ip: context.ip });
    if (throttle.blocked) return { ok: false, error: `Too many invitations to that address. Try again in ${formatRetryAfter(throttle.retryAfterMs)}.` };
    const sentToday = await prisma.authToken.count({
      where: { purpose: "invite", invitedById: session.userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    if (sentToday >= MAX_INVITES_PER_OWNER_PER_DAY) return { ok: false, error: "You've reached today's invitation limit. Try again tomorrow." };
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: session.workspaceId } });
    const result = await sendInviteEmail({ workspaceId: workspace.id, workspaceName: workspace.name, email, role: "member", invitedById: session.userId, invitedByEmail: session.email, context });
    // Counted once the invitation actually went out, so a failed send does not burn the owner's quota.
    await recordEmailRequest("invite", email, { ip: context.ip });
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "member.invite", targetType: "invite", metadata: { email, role: "member", delivered: result.delivered } });
    return { ok: true, message: result.delivered ? "Invitation sent." : "Share this invitation privately with the intended teammate.", ...(!result.delivered ? { link: result.link } : {}) };
  }
  if (operation === "revoke-invite") {
    await revokeInvites(session.workspaceId, id);
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "member.invite_revoke", targetType: "invite", targetId: id });
  } else {
    const membership = await getWorkspaceMembership(session.workspaceId, id);
    if (!membership) return { ok: false, error: "This member is no longer available." };
    if (operation === "reset") {
      const result = await sendPasswordResetEmail({ userId: membership.user.id, email: membership.user.email, issuedByOwner: true, context: await getContext() });
      await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "member.password_reset", targetType: "user", targetId: membership.user.id, metadata: { delivered: result.delivered } });
      // A reset link controls the whole account, including other tenants.
      // Only the mailbox may receive it for a cross-workspace account.
      const canShow = !result.delivered && await userBelongsOnlyTo(membership.user.id, session.workspaceId);
      return { ok: true, message: result.delivered ? "Password reset email sent." : canShow ? "Share this reset link privately with the member." : "Email delivery is required to reset this account.", ...(canShow ? { link: result.link } : {}) };
    }
    const newRole = input.role === "owner" ? "owner" : "member";
    const result = operation === "remove" ? await removeWorkspaceMember(session.workspaceId, id) : operation === "role" ? await changeMemberRole(session.workspaceId, id, newRole) : null;
    if (!result) return { ok: false, error: "Unknown action." };
    if (!result.ok) return { ok: false, error: result.reason === "last-owner" ? "Keep at least one owner in the workspace." : "This member is no longer available." };
    await recordAudit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      action: operation === "remove" ? "member.remove" : "member.role_change",
      targetType: "user",
      targetId: membership.user.id,
      ...(operation === "role" ? { metadata: { role: newRole } } : {}),
    });
  }
  return { ok: true, message: "Saved." };
}

export interface TeamRoster {
  members: { id: string; email: string; role: "owner" | "member"; joinedAt: string }[];
  invites: { id: string; email: string; role: string; createdAt: string }[];
  retentionDays: number | null;
}

export async function loadTeamRoster(workspaceId: string): Promise<TeamRoster> {
  const [members, workspace, invites] = await Promise.all([
    prisma.workspaceMembership.findMany({
      where: { workspaceId },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { retentionDays: true } }),
    listPendingInvites(workspaceId),
  ]);
  return {
    members: members.map((member) => ({ id: member.id, email: member.user.email, role: member.role as "owner" | "member", joinedAt: member.createdAt.toISOString() })),
    invites: invites.map((invite) => ({ id: invite.id, email: invite.email, role: String(invite.role ?? "member"), createdAt: new Date(invite.createdAt).toISOString() })),
    retentionDays: workspace.retentionDays,
  };
}
