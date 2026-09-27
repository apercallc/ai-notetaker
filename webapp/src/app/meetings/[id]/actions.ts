"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { deleteMeeting, renameMeeting, updateActionItem, ValidationError } from "@/lib/meetings";
import { requireSession } from "@/lib/currentUser";
import { createMeetingShare, revokeMeetingShare, SharingValidationError } from "@/lib/sharing";
import { retryMeetingProcessing } from "@/lib/meetingProcessing";
import { isValidDateOnly } from "@/lib/actionItems";

export type ShareActionResult =
  | { ok: true; id: string; token: string; expiresAt: string }
  | { ok: false; error: string };

export async function createMeetingShareAction(formData: FormData): Promise<ShareActionResult> {
  const { workspaceId } = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "");
  const expiresInDays = Number(formData.get("expiresInDays") ?? "7");
  try {
    const share = await createMeetingShare(workspaceId, meetingId, expiresInDays);
    revalidatePath(`/meetings/${meetingId}`);
    return { ok: true, id: share.id, token: share.token, expiresAt: share.expiresAt.toISOString() };
  } catch (error) {
    if (error instanceof SharingValidationError) return { ok: false, error: error.message };
    console.error("meeting share creation failed", { meetingId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not create a share link. Try again." };
  }
}

export async function revokeMeetingShareAction(formData: FormData): Promise<boolean> {
  const { workspaceId } = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "");
  let revoked = false;
  try {
    revoked = await revokeMeetingShare(workspaceId, String(formData.get("shareId") ?? ""));
  } catch (error) {
    if (!(error instanceof SharingValidationError)) throw error;
  }
  if (meetingId) revalidatePath(`/meetings/${meetingId}`);
  return revoked;
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

export type RenameState = { status: "saved"; title: string } | { status: "error"; message: string };

export async function renameMeetingAction(formData: FormData): Promise<RenameState> {
  const { workspaceId } = await requireSession();
  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "");
  try {
    if (!(await renameMeeting(workspaceId, id, title))) return { status: "error", message: "This meeting no longer exists." };
  } catch (error) {
    if (error instanceof ValidationError) return { status: "error", message: error.message.replace(/^title/, "Title") };
    console.error("meeting rename failed", { id, error: error instanceof Error ? error.message : String(error) });
    return { status: "error", message: "Couldn't save the title. Try again." };
  }
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${id}`);
  return { status: "saved", title: title.trim() };
}

export type ActionUpdateState = { status: "saved" } | { status: "error"; message: string };

/**
 * Autosave for one action item (done state and due date together). It
 * reports problems as state instead of redirecting, so an error shows next to
 * the item it belongs to and the reader keeps their place.
 */
export async function updateActionItemAction(formData: FormData): Promise<ActionUpdateState> {
  const { workspaceId } = await requireSession();
  const id = String(formData.get("id") ?? "");
  const meetingId = String(formData.get("meetingId") ?? "");
  const surface = String(formData.get("surface") ?? "");
  const status = formData.get("done") === "1" ? "done" : "open";
  const dueAtValue = String(formData.get("dueAt") ?? "");
  const fail = (message: string): ActionUpdateState => ({ status: "error", message });

  if (!id) return fail("That action item is missing.");
  if (dueAtValue && !isValidDateOnly(dueAtValue)) return fail("Enter a valid due date.");

  let updated: boolean;
  try {
    updated = await updateActionItem(workspaceId, id, { status, dueAt: dueAtValue ? `${dueAtValue}T00:00:00.000Z` : null });
  } catch (error) {
    console.error("action item update failed", { id, error: error instanceof Error ? error.message : String(error) });
    return fail("Couldn't save. Check your connection and try again.");
  }
  if (!updated) return fail("This action item no longer exists.");

  // The surface that made the change already shows the new state; refreshing
  // it would, for instance, drop a just-completed item out of an "Open" list
  // under the user's cursor. Everything else gets invalidated.
  if (surface !== "actions") revalidatePath("/actions");
  revalidatePath("/meetings");
  if (meetingId && surface !== "meeting") revalidatePath(`/meetings/${meetingId}`);
  return { status: "saved" };
}

export type RetryState = { status: "started" } | { status: "error"; message: string };

export async function retryProcessingAction(formData: FormData): Promise<RetryState> {
  const { workspaceId } = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "");
  const result = await retryMeetingProcessing(workspaceId, meetingId);
  if (!result.ok) return { status: "error", message: result.error };
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${meetingId}`);
  return { status: "started" };
}
