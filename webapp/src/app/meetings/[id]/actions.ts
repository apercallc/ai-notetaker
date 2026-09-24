"use server";

import { redirect } from "next/navigation";
import { deleteMeeting, updateActionItem } from "@/lib/meetings";
import { requireSession } from "@/lib/currentUser";
import { createMeetingShare, revokeMeetingShare, SharingValidationError } from "@/lib/sharing";
import { revalidatePath } from "next/cache";

export type ShareActionResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; error: string };

export async function createMeetingShareAction(formData: FormData): Promise<ShareActionResult> {
  const { workspaceId } = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "");
  const expiresInDays = Number(formData.get("expiresInDays") ?? "7");
  try {
    const share = await createMeetingShare(workspaceId, meetingId, expiresInDays);
    return { ok: true, token: share.token, expiresAt: share.expiresAt.toISOString() };
  } catch (error) {
    if (error instanceof SharingValidationError) return { ok: false, error: error.message };
    console.error("meeting share creation failed", { meetingId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not create a share link. Try again." };
  }
}

export async function revokeMeetingShareAction(formData: FormData): Promise<boolean> {
  const { workspaceId } = await requireSession();
  return revokeMeetingShare(workspaceId, String(formData.get("shareId") ?? ""));
}

export async function deleteMeetingAction(formData: FormData): Promise<void> {
  const { workspaceId } = await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect("/meetings?error=invalid-delete");
  }
  try {
    await deleteMeeting(workspaceId, id);
  } catch (error) {
    console.error("meeting deletion failed", { id, error: error instanceof Error ? error.message : String(error) });
    redirect("/meetings?error=delete-failed");
  }
  redirect("/meetings");
}

export async function updateActionItemAction(formData: FormData): Promise<void> {
  const { workspaceId } = await requireSession();
  const id = String(formData.get("id") ?? "");
  const meetingId = String(formData.get("meetingId") ?? "");
  const statusValue = formData.get("done") === "1" ? "done" : "open";
  const dueAtValue = String(formData.get("dueAt") ?? "");

  if (!id) {
    redirect("/actions?error=invalid-action");
  }

  let dueAt: string | null = null;
  if (dueAtValue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueAtValue)) {
      redirect("/actions?error=invalid-date");
    }
    dueAt = `${dueAtValue}T00:00:00.000Z`;
  }

  let updated: boolean;
  try {
    updated = await updateActionItem(workspaceId, id, { status: statusValue, dueAt });
  } catch (error) {
    console.error("action item update failed", { id, error: error instanceof Error ? error.message : String(error) });
    redirect("/actions?error=update-failed");
  }
  if (!updated) {
    redirect("/actions?error=missing-action");
  }

  revalidatePath("/actions");
  revalidatePath("/meetings");
  if (meetingId) revalidatePath(`/meetings/${meetingId}`);
}
