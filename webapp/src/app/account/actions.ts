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
import { deleteObject } from "@/lib/objectStorage";
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

  // Legacy meetings have no Workspace foreign key. Gather every private
  // object key up front, then delete the rows in ONE transaction so a
  // mid-loop failure cannot leave a half-deleted workspace (some meetings
  // gone, workspace still present, user confused about what happened).
  // Object storage is cleaned up after the commit; a storage failure logs
  // the orphaned keys for operator repair rather than rolling back a
  // deletion the user already confirmed.
  const meetings = await prisma.meeting.findMany({
    where: { workspaceId: session.workspaceId },
    select: { id: true, recordingObjectKey: true, uploads: { select: { objectKey: true, chunks: { select: { objectKey: true } } } } },
  });
  const objectKeys = meetings.flatMap((meeting) => [
    meeting.recordingObjectKey,
    ...meeting.uploads.flatMap((upload) => [upload.objectKey, ...upload.chunks.map((chunk) => chunk.objectKey)]),
  ]).filter((key): key is string => Boolean(key));

  await prisma.$transaction(async (tx) => {
    // Deletes cascade from the workspace row to membership/subscription/
    // upload/job/share rows, but legacy meetings have no Workspace relation,
    // so they are removed explicitly — inside the same transaction.
    await tx.meeting.deleteMany({ where: { workspaceId: session.workspaceId } });
    await tx.workspace.delete({ where: { id: session.workspaceId } });
    // An account whose last workspace is gone can never sign in again and
    // would squat its email address — remove it.
    for (const userId of memberUserIds) {
      await tx.user.deleteMany({ where: { id: userId, memberships: { none: {} } } });
    }
  });

  const cleanup = await Promise.allSettled(objectKeys.map((key) => deleteObject(key)));
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) {
    console.error("workspace deletion object cleanup failed", {
      workspaceId: session.workspaceId,
      failedObjects: failures.length,
      firstError: failures[0]?.reason instanceof Error ? failures[0].reason.message : String(failures[0]?.reason),
    });
  }

  await clearSessionCookie();
  redirect("/login");
}
