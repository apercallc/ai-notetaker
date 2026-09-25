"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/currentUser";
import { getRequestContext } from "@/lib/requestContext";
import { clearSessionCookie } from "@/lib/sessionCookie";
import { changePassword } from "@/lib/accounts";
import { formatRetryAfter } from "@/lib/loginThrottle";
import { passwordProblemMessage } from "@/lib/passwordPolicy";
import { createApiToken, revokeApiToken, revokeAllApiTokens } from "@/lib/apiTokens";
import { deleteMeeting } from "@/lib/meetings";
import { deleteUserSessions, revokeUserSession, setSessionActiveWorkspace } from "@/lib/sessions";
import { getUserRole, removeWorkspaceMember } from "@/lib/workspaces";

/**
 * Expected failures are returned as values, never thrown: Next replaces a
 * thrown error's message with a generic one in production, so anything the
 * person must act on has to come back through the return value.
 *
 * Every action re-resolves the session (and thus membership of the active
 * workspace) — nothing here trusts a workspaceId from the client.
 */

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

// ------------------------------------------------------------ password

export type ChangePasswordState =
  | { ok: true }
  | { ok: false; error: string };

export async function changePasswordAction(formData: FormData): Promise<ChangePasswordState> {
  const session = await requireSession({ allowPasswordChange: true });
  const result = await changePassword({
    userId: session.userId,
    keepSessionId: session.sessionId,
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });
  if (result.ok) {
    revalidatePath("/account");
    return { ok: true };
  }
  switch (result.reason) {
    case "wrong-password":
      return { ok: false, error: "That current password is incorrect. Try again." };
    case "mismatch":
      return { ok: false, error: "The two new passwords don't match." };
    case "same-password":
      return { ok: false, error: "Choose a password you haven't used before." };
    case "weak-password":
      return { ok: false, error: result.problem ? passwordProblemMessage(result.problem) : "Choose a stronger password." };
    case "throttled":
      return { ok: false, error: `Too many attempts — try again in ${formatRetryAfter(result.retryAfterMs ?? 60_000)}.` };
  }
}

// ------------------------------------------------------------ sessions

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const session = await requireSession({ allowPasswordChange: true });
  const sessionId = field(formData, "sessionId");
  if (!sessionId) return;
  await revokeUserSession(session.userId, sessionId);
  if (sessionId === session.sessionId) {
    await clearSessionCookie();
    redirect("/login?notice=session-expired");
  }
  revalidatePath("/account");
}

/** Signs the user out of every device, including this one. */
export async function signOutEverywhereAction(): Promise<void> {
  const session = await requireSession({ allowPasswordChange: true });
  await deleteUserSessions(session.userId);
  await revokeAllApiTokens(session.userId);
  await clearSessionCookie();
  redirect("/login?notice=session-expired");
}

// ------------------------------------------------------------ API tokens

export type CreateApiTokenState =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; error: string };

export async function createApiTokenAction(formData: FormData): Promise<CreateApiTokenState> {
  const session = await requireSession();
  const context = await getRequestContext();
  const created = await createApiToken(session.userId, {
    label: field(formData, "label") || "Extension sign-in",
    userAgent: context.userAgent,
  });
  revalidatePath("/account");
  return { ok: true, token: created.token, expiresAt: created.expiresAt.toISOString() };
}

export async function revokeApiTokenAction(formData: FormData): Promise<void> {
  const session = await requireSession({ allowPasswordChange: true });
  const tokenId = field(formData, "tokenId");
  if (!tokenId) return;
  await revokeApiToken(session.userId, tokenId);
  revalidatePath("/account");
}

// ------------------------------------------------------ workspace switcher

export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const session = await requireSession({ allowPasswordChange: true });
  const workspaceId = field(formData, "workspaceId");
  // Membership is re-checked, so a stale or guessed id simply lands on the default.
  const role = workspaceId ? await getUserRole(session.userId, workspaceId) : null;
  if (workspaceId && role) {
    await setSessionActiveWorkspace(session.sessionId, workspaceId);
  }
  redirect("/meetings");
}

// ------------------------------------------------------------ danger zone

export type LeaveWorkspaceState = { ok: true; accountDeleted: boolean } | { ok: false; error: string };

/** A member (or a non-sole owner) leaves the current workspace. */
export async function leaveWorkspaceAction(formData: FormData): Promise<LeaveWorkspaceState> {
  const session = await requireSession({ allowPasswordChange: true });
  const confirmation = field(formData, "confirm");
  const workspace = await prisma.workspace.findUnique({
    where: { id: session.workspaceId },
    select: { name: true },
  });
  if (!workspace || confirmation !== workspace.name) {
    return { ok: false, error: "Type the workspace name exactly to confirm." };
  }
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: session.userId, workspaceId: session.workspaceId } },
  });
  if (!membership) return { ok: false, error: "You are no longer a member of this workspace." };

  const result = await removeWorkspaceMember(session.workspaceId, membership.id);
  if (!result.ok && result.reason === "last-owner") {
    return { ok: false, error: "You're the last owner — promote another member before leaving." };
  }
  if (!result.ok) return { ok: false, error: "Could not leave the workspace. Try again." };
  if (result.accountDeleted) {
    await clearSessionCookie();
    redirect("/login");
  }
  redirect("/meetings");
}

export type DeleteWorkspaceState = { ok: true } | { ok: false; error: string };

/**
 * An owner deletes the entire workspace: every meeting, invite, and the
 * accounts of any member who belongs to nothing else. Typed confirmation
 * (the workspace name) is required, and it can never run for a workspace the
 * caller doesn't own — the id comes from the session, not the form.
 */
export async function deleteWorkspaceAction(formData: FormData): Promise<DeleteWorkspaceState> {
  const session = await requireSession({ allowPasswordChange: true });
  if (session.role !== "owner") return { ok: false, error: "Only the workspace owner can delete the workspace." };

  const confirmation = field(formData, "confirm");
  const workspace = await prisma.workspace.findUnique({
    where: { id: session.workspaceId },
    select: { name: true },
  });
  if (!workspace || confirmation !== workspace.name) {
    return { ok: false, error: "Type the workspace name exactly to confirm." };
  }

  const memberUserIds = (
    await prisma.workspaceMembership.findMany({
      where: { workspaceId: session.workspaceId },
      select: { userId: true },
    })
  ).map((membership) => membership.userId);

  // Legacy meetings have no Workspace foreign key. Remove their private
  // objects through the same cleanup path as individual meeting deletion.
  const meetings = await prisma.meeting.findMany({ where: { workspaceId: session.workspaceId }, select: { id: true } });
  for (const meeting of meetings) await deleteMeeting(session.workspaceId, meeting.id);
  await prisma.workspace.delete({ where: { id: session.workspaceId } });

  // An account whose last workspace is gone can never sign in again and
  // would squat its email address — remove it.
  for (const userId of memberUserIds) {
    await prisma.user.deleteMany({ where: { id: userId, memberships: { none: {} } } });
  }

  await clearSessionCookie();
  redirect("/login");
}
