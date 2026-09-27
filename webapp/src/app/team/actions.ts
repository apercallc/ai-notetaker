"use server";

import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/currentUser";
import { hashPassword } from "@/lib/passwords";
import { addWorkspaceMember, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, updateWorkspaceRetentionDays } from "@/lib/workspaces";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { normalizeEmail, isPlausibleEmail } from "@/lib/email";
import { sendInviteEmail, sendPasswordResetEmail } from "@/lib/authEmails";
import { getRequestContext } from "@/lib/requestContext";
import { changeMemberRole, removeWorkspaceMember, getWorkspaceMembership, userBelongsOnlyTo } from "@/lib/workspaces";
import { revokeInvites } from "@/lib/authTokens";

/**
 * Expected failures are returned, never thrown.
 *
 * Next.js replaces the message of anything thrown out of a Server Action in
 * a production build with a generic string plus a digest — so throwing
 * `ForbiddenError("Only the workspace owner can add members.")` reached the
 * user as "An unexpected response was received from the server", and a
 * duplicate email surfaced as the same unhelpful text. Anything a person can
 * actually act on has to come back as a value.
 */
export type AddMemberResult =
  | { ok: true; email: string; temporaryPassword: string }
  | { ok: false; error: string };

function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url"); // 16 chars, URL-safe, easy to read aloud/copy
}

export async function addMember(formData: FormData): Promise<AddMemberResult> {
  const session = await requireSession();
  if (session.role !== "owner") {
    return { ok: false, error: "Only the workspace owner can add members." };
  }

  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!email) {
    return { ok: false, error: "Enter an email address." };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    await addWorkspaceMember(session.workspaceId, email, passwordHash, { mustChangePassword: true });
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

  revalidatePath("/team");
  return { ok: true, email, temporaryPassword };
}

export type TeamActionResult = { ok: true; link?: string; message: string } | { ok: false; error: string };

export async function manageTeam(formData: FormData): Promise<TeamActionResult> {
  const session = await requireSession();
  if (session.role !== "owner") return { ok: false, error: "Only owners can manage this workspace." };
  const operation = String(formData.get("operation") ?? "");
  const id = String(formData.get("id") ?? "");
  if (operation === "invite") {
    const email = normalizeEmail(String(formData.get("email") ?? ""));
    if (!isPlausibleEmail(email)) return { ok: false, error: "Enter a valid email address." };
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: session.workspaceId } });
    const result = await sendInviteEmail({ workspaceId: workspace.id, workspaceName: workspace.name, email, role: "member", invitedById: session.userId, invitedByEmail: session.email, context: await getRequestContext() });
    revalidatePath("/team");
    return { ok: true, message: result.delivered ? "Invitation sent." : "Share this invitation privately with the intended teammate.", ...(!result.delivered ? { link: result.link } : {}) };
  }
  if (operation === "revoke-invite") {
    await revokeInvites(session.workspaceId, id);
  } else {
    const membership = await getWorkspaceMembership(session.workspaceId, id);
    if (!membership) return { ok: false, error: "This member is no longer available." };
    if (operation === "reset") {
      const result = await sendPasswordResetEmail({ userId: membership.user.id, email: membership.user.email, issuedByOwner: true, context: await getRequestContext() });
      // A reset link controls the whole account, including other tenants.
      // Only the mailbox may receive it for a cross-workspace account.
      const canShow = !result.delivered && await userBelongsOnlyTo(membership.user.id, session.workspaceId);
      return { ok: true, message: result.delivered ? "Password reset email sent." : canShow ? "Share this reset link privately with the member." : "Email delivery is required to reset this account.", ...(canShow ? { link: result.link } : {}) };
    }
    const result = operation === "remove" ? await removeWorkspaceMember(session.workspaceId, id) : operation === "role" ? await changeMemberRole(session.workspaceId, id, formData.get("role") === "owner" ? "owner" : "member") : null;
    if (!result) return { ok: false, error: "Unknown action." };
    if (!result.ok) return { ok: false, error: result.reason === "last-owner" ? "Keep at least one owner in the workspace." : "This member is no longer available." };
  }
  revalidatePath("/team");
  return { ok: true, message: "Saved." };
}

export type RetentionPolicyResult =
  | { ok: true; retentionDays: number | null }
  | { ok: false; error: string };

export async function updateRetentionPolicy(formData: FormData): Promise<RetentionPolicyResult> {
  const session = await requireSession();
  if (session.role !== "owner") return { ok: false, error: "Only the workspace owner can change retention." };

  const value = String(formData.get("retentionDays") ?? "").trim();
  const retentionDays = value === "never" ? null : Number(value);
  if (retentionDays !== null && (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS)) {
    return { ok: false, error: `Choose never or a value from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days.` };
  }

  try {
    await updateWorkspaceRetentionDays(session.workspaceId, retentionDays);
  } catch (error) {
    console.error("retention policy update failed", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not save the retention policy. Try again." };
  }
  revalidatePath("/team");
  return { ok: true, retentionDays };
}
