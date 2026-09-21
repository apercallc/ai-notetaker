"use server";

import { redirect } from "next/navigation";
import { deleteMeeting, updateActionItem } from "@/lib/meetings";
import { revalidatePath } from "next/cache";

export async function deleteMeetingAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await deleteMeeting(id);
  redirect("/meetings");
}

export async function updateActionItemAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const meetingId = String(formData.get("meetingId") ?? "");
  const statusValue = formData.get("done") === "1" ? "done" : "open";
  const dueAtValue = String(formData.get("dueAt") ?? "");

  if (!id) return;

  let dueAt: string | null = null;
  if (dueAtValue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueAtValue)) return;
    dueAt = `${dueAtValue}T00:00:00.000Z`;
  }

  await updateActionItem(id, {
    status: statusValue,
    dueAt,
  });

  revalidatePath("/actions");
  revalidatePath("/meetings");
  if (meetingId) revalidatePath(`/meetings/${meetingId}`);
}
