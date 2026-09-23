"use server";

import { redirect } from "next/navigation";
import { deleteMeeting, updateActionItem } from "@/lib/meetings";
import { requireSession } from "@/lib/currentUser";
import { revalidatePath } from "next/cache";

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
