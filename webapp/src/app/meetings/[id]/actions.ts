"use server";

import { redirect } from "next/navigation";
import { deleteMeeting } from "@/lib/meetings";

export async function deleteMeetingAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await deleteMeeting(id);
  redirect("/meetings");
}
