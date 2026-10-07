"use server";

import { requireSession } from "@/lib/currentUser";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, updateWorkspaceRetentionDays } from "@/lib/workspaces";
import { revalidatePath } from "next/cache";
import { getRequestContext } from "@/lib/requestContext";
import { recordAudit } from "@/lib/audit";
import { addMemberAs, manageTeamAs, type AddMemberResult, type TeamActionResult } from "@/lib/teamAdmin";

export type { AddMemberResult, TeamActionResult };

export async function addMember(formData: FormData): Promise<AddMemberResult> {
  const session = await requireSession();
  const result = await addMemberAs(session, String(formData.get("email") ?? ""));
  if (result.ok) revalidatePath("/team");
  return result;
}

export async function manageTeam(formData: FormData): Promise<TeamActionResult> {
  // requireSession signals "sign in" by throwing a redirect, so it stays outside the try inside manageTeamAs.
  const session = await requireSession();
  const result = await manageTeamAs(
    session,
    {
      operation: String(formData.get("operation") ?? ""),
      id: String(formData.get("id") ?? ""),
      email: String(formData.get("email") ?? ""),
      role: String(formData.get("role") ?? ""),
    },
    getRequestContext,
  );
  if (result.ok) revalidatePath("/team");
  return result;
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
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "workspace.retention_update", targetType: "workspace", targetId: session.workspaceId, metadata: { retentionDays } });
  } catch (error) {
    console.error("retention policy update failed", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not save the retention policy. Try again." };
  }
  revalidatePath("/team");
  return { ok: true, retentionDays };
}
