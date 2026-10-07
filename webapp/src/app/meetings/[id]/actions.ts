"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { renameMeeting, updateActionItem, ValidationError } from "@/lib/meetings";
import { trashNote } from "@/lib/library";
import { restorePreviousBody, updateNoteBody } from "@/lib/noteEditing";
import { recordAudit } from "@/lib/audit";
import { requireSession } from "@/lib/currentUser";
import { writeBlock } from "@/lib/workspaceAccess";
import { prisma } from "@/lib/db";
import { createMeetingShare, revokeMeetingShare, SharingValidationError } from "@/lib/sharing";
import { retryMeetingProcessing } from "@/lib/meetingProcessing";
import { regenerateNotes } from "@/lib/notesRegenerate";
import { renameSpeaker } from "@/lib/speakers";
import { isValidDateOnly } from "@/lib/actionItems";
import { createSlidingWindowLimiter } from "@/lib/lookupThrottle";

export type ShareActionResult =
  | { ok: true; id: string; token: string; expiresAt: string | null }
  | { ok: false; error: string };

export async function createMeetingShareAction(formData: FormData): Promise<ShareActionResult> {
  const { workspaceId, userId, role } = await requireSession();
  const blocked = await writeBlock(workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const meetingId = String(formData.get("meetingId") ?? "").slice(0, 128);
  const rawExpiry = String(formData.get("expiresInDays") ?? "7");
  const expiresInDays = rawExpiry === "never" ? null : Number(rawExpiry);
  try {
    // A link that never expires is a standing public door to the note, so only its author or a workspace owner may open one.
    if (expiresInDays === null && role !== "owner") {
      const author = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId, deletedAt: null }, select: { userId: true } });
      if (author && author.userId !== userId) return { ok: false, error: "Only the note's author or a workspace owner can create a link that never expires." };
    }
    const share = await createMeetingShare(workspaceId, meetingId, expiresInDays);
    await recordAudit({ workspaceId, actorUserId: userId, action: "share.create", targetType: "meeting", targetId: meetingId, metadata: { expiresInDays } });
    revalidatePath(`/meetings/${meetingId}`);
    return { ok: true, id: share.id, token: share.token, expiresAt: share.expiresAt?.toISOString() ?? null };
  } catch (error) {
    if (error instanceof SharingValidationError) return { ok: false, error: error.message };
    console.error("meeting share creation failed", { meetingId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not create a share link. Try again." };
  }
}

export async function revokeMeetingShareAction(formData: FormData): Promise<boolean> {
  const { workspaceId, userId } = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "").slice(0, 128);
  let revoked = false;
  if (!meetingId) return false;
  try {
    revoked = await revokeMeetingShare(workspaceId, String(formData.get("shareId") ?? ""), meetingId);
  } catch (error) {
    if (!(error instanceof SharingValidationError)) throw error;
  }
  if (revoked) await recordAudit({ workspaceId, actorUserId: userId, action: "share.revoke", targetType: "meeting", targetId: meetingId });
  if (revoked) revalidatePath(`/meetings/${meetingId}`);
  return revoked;
}

export async function deleteMeetingAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect("/meetings?error=invalid-delete");
  }
  let denied: string | null = null;
  try {
    // Deleting a note moves it to the Trash, where it can be restored for 30 days.
    const result = await trashNote(session, id);
    if (!result.ok) denied = result.error;
  } catch (error) {
    console.error("meeting deletion failed", { id, error: error instanceof Error ? error.message : String(error) });
    redirect("/meetings?error=delete-failed");
  }
  if (denied) redirect(`/meetings/${id}?error=${encodeURIComponent(denied)}`);
  redirect("/meetings?notice=trashed");
}

export type RenameState = { status: "saved"; title: string } | { status: "error"; message: string };

export async function renameMeetingAction(formData: FormData): Promise<RenameState> {
  const { workspaceId } = await requireSession();
  const blocked = await writeBlock(workspaceId);
  if (blocked) return { status: "error", message: blocked };
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
  const blocked = await writeBlock(workspaceId);
  if (blocked) return { status: "error", message: blocked };
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

/**
 * Next masks an error thrown from a server action with a generic message, which the
 * note screens render as a blank failure. Log the real cause and hand back a state
 * the UI can show.
 */
async function failSoft<T>(label: string, meetingId: string, work: () => Promise<T>, message: string): Promise<T | { status: "error"; message: string }> {
  try {
    return await work();
  } catch (error) {
    console.error(label, { meetingId, error: error instanceof Error ? error.message : String(error) });
    return { status: "error", message };
  }
}

export type RetryState = { status: "started" } | { status: "error"; message: string };

// A retry can re-run paid provider calls. A few per minute per note is plenty for a person; a stuck
// button or a script is not. (Per server process, like the share-page limiter.)
const retryLimiter = createSlidingWindowLimiter({ limit: 3, windowMs: 60_000 });

export async function retryProcessingAction(formData: FormData): Promise<RetryState> {
  const { workspaceId } = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "");
  if (!retryLimiter.hit(`${workspaceId}:${meetingId}`).allowed) {
    return { status: "error", message: "That note was retried a few times just now. Give it a minute, then try again." };
  }
  const result = await failSoft("retry processing failed", meetingId, () => retryMeetingProcessing(workspaceId, meetingId), "Couldn't restart processing. Try again.");
  if ("status" in result) return result;
  if (!result.ok) return { status: "error", message: result.error };
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${meetingId}`);
  return { status: "started" };
}

export type RegenerateState = { status: "done"; remaining: number } | { status: "error"; message: string };

export async function regenerateNotesAction(formData: FormData): Promise<RegenerateState> {
  const session = await requireSession();
  const meetingId = String(formData.get("meetingId") ?? "");
  const result = await failSoft(
    "regenerate notes failed",
    meetingId,
    () => regenerateNotes(session, meetingId, String(formData.get("template") ?? ""), { summaryLanguage: String(formData.get("summaryLanguage") ?? "") }),
    "Couldn't regenerate the notes. Try again.",
  );
  if ("status" in result) return result;
  if (!result.ok) return { status: "error", message: result.error };
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath("/actions");
  return { status: "done", remaining: result.remaining };
}

export type SpeakerRenameState = { status: "saved"; label: string } | { status: "error"; message: string };

export async function renameSpeakerAction(formData: FormData): Promise<SpeakerRenameState> {
  const { workspaceId } = await requireSession();
  const blocked = await writeBlock(workspaceId);
  if (blocked) return { status: "error", message: blocked };
  const meetingId = String(formData.get("meetingId") ?? "");
  let result;
  try {
    result = await renameSpeaker(workspaceId, meetingId, String(formData.get("speakerKey") ?? ""), String(formData.get("name") ?? ""));
  } catch (error) {
    console.error("speaker rename failed", { meetingId, error: error instanceof Error ? error.message : String(error) });
    return { status: "error", message: "Couldn't save the name. Try again." };
  }
  if (!result.ok) return { status: "error", message: result.error };
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath("/meetings");
  revalidatePath("/actions");
  return { status: "saved", label: result.label };
}

export type SaveBodyState = { status: "saved"; version: string } | { status: "conflict" | "error"; message: string };

export async function saveNoteBodyAction(formData: FormData): Promise<SaveBodyState> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { status: "error", message: blocked };
  const meetingId = String(formData.get("meetingId") ?? "");
  const result = await failSoft(
    "saving note body failed",
    meetingId,
    () => updateNoteBody(session, meetingId, String(formData.get("body") ?? ""), String(formData.get("version") ?? "")),
    "Couldn't save your edit. Your text is still on screen; try again.",
  );
  if ("status" in result) return result;
  if (!result.ok) return { status: "conflict" in result ? "conflict" : "error", message: result.error };
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath("/meetings");
  return { status: "saved", version: result.version };
}

export async function restorePreviousBodyAction(formData: FormData): Promise<SaveBodyState> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { status: "error", message: blocked };
  const meetingId = String(formData.get("meetingId") ?? "");
  const result = await failSoft("restoring previous body failed", meetingId, () => restorePreviousBody(session, meetingId), "Couldn't restore the previous version. Try again.");
  if ("status" in result) return result;
  if (!result.ok) return { status: "error", message: result.error };
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath("/meetings");
  return { status: "saved", version: result.version };
}
