"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/currentUser";
import { writeBlock } from "@/lib/workspaceAccess";
import { createFolder, moveFolder, moveNotes, renameFolder, restoreFromTrash, trashFolder, trashNote } from "@/lib/library";
import { ValidationError, renameMeeting } from "@/lib/meetings";
import { MAX_NOTE_UPLOAD_BYTES, createNote, isNoteUploadName, titleFromFileName } from "@/lib/noteEditing";

/**
 * Library actions. Expected failures come back as values, never thrown: Next
 * replaces the message of a thrown server-action error in production.
 */
export type LibraryResult = { ok: true; message?: string; id?: string; name?: string } | { ok: false; error: string };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");
const optionalId = (formData: FormData, name: string): string | null => text(formData, name).trim() || null;

function refresh(): void {
  revalidatePath("/meetings");
  revalidatePath("/trash");
}

export async function createFolderAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const result = await createFolder(session, optionalId(formData, "parentId"), text(formData, "name"));
  if (!result.ok) return result;
  refresh();
  return { ok: true, id: result.id, name: result.name };
}

export async function renameFolderAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const result = await renameFolder(session, text(formData, "id"), text(formData, "name"));
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

export async function moveNotesAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const result = await moveNotes(session, formData.getAll("id").map(String), optionalId(formData, "folderId"));
  if (!result.ok) return result;
  refresh();
  revalidatePath("/meetings/[id]", "page");
  return { ok: true, message: result.moved === 1 ? "Moved." : `Moved ${result.moved} notes.` };
}

export async function trashFolderAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const result = await trashFolder(session, text(formData, "id"));
  if (!result.ok) return result;
  refresh();
  const items = result.notes === 1 ? "1 note" : `${result.notes} notes`;
  return { ok: true, message: `Folder moved to Trash with ${items}.` };
}

/** Creates an empty note and opens it for typing. */
export async function createNoteAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  if (await writeBlock(session.workspaceId)) redirect("/meetings?error=note-create-failed");
  const folderId = optionalId(formData, "folderId");
  const result = await createNote(session, { folderId, source: "manual" });
  if (!result.ok) redirect(`/meetings?${folderId ? `folder=${encodeURIComponent(folderId)}&` : ""}error=note-create-failed`);
  revalidatePath("/meetings");
  redirect(`/meetings/${result.id}?edit=1`);
}

/** The browser reads a small .md/.txt file and sends its text; nothing binary reaches the server. */
export async function uploadNoteAction(formData: FormData): Promise<LibraryResult & { id?: string }> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const fileName = text(formData, "fileName");
  const body = text(formData, "body");
  if (!isNoteUploadName(fileName)) return { ok: false, error: "Upload a .md, .markdown or .txt file." };
  if (new TextEncoder().encode(body).length > MAX_NOTE_UPLOAD_BYTES) return { ok: false, error: `That file is too large. The limit is ${MAX_NOTE_UPLOAD_BYTES / 1024} KB.` };
  const result = await createNote(session, { title: titleFromFileName(fileName), body, folderId: optionalId(formData, "folderId"), source: "upload" });
  if (!result.ok) return result;
  refresh();
  return { ok: true, id: result.id };
}

/** Renames a note from the library list (the same title rules as the note page). */
export async function renameNoteAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  try {
    const renamed = await renameMeeting(session.workspaceId, text(formData, "id"), text(formData, "title"));
    if (!renamed) return { ok: false, error: "This note no longer exists." };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.message.replace(/^title is required$/u, "Enter a title.") };
    throw error;
  }
  refresh();
  revalidatePath("/meetings/[id]", "page");
  return { ok: true };
}

/**
 * Bulk results. One failure never hides what did succeed: `done` lists the
 * items that changed (so the caller can offer Undo) and `failed` counts the rest.
 */
export type BulkResult =
  | { ok: true; message: string; done: number; failed: number; error?: string }
  | { ok: false; error: string };

const MAX_BULK_ITEMS = 200;

function bulkIds(formData: FormData): { noteIds: string[]; folderIds: string[] } | null {
  const noteIds = [...new Set(formData.getAll("noteId").map(String).filter(Boolean))];
  const folderIds = [...new Set(formData.getAll("folderId").map(String).filter(Boolean))];
  if (noteIds.length + folderIds.length === 0 || noteIds.length + folderIds.length > MAX_BULK_ITEMS) return null;
  return { noteIds, folderIds };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Moves any mix of notes and folders to one destination (`destination` empty = top level). */
export async function moveItemsAction(formData: FormData): Promise<BulkResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const ids = bulkIds(formData);
  if (!ids) return { ok: false, error: "Choose between 1 and 200 items." };
  const destination = optionalId(formData, "destination");
  let done = 0;
  let failed = 0;
  let firstError: string | undefined;
  if (ids.noteIds.length > 0) {
    const result = await moveNotes(session, ids.noteIds, destination);
    if (result.ok) {
      done += result.moved;
      failed += ids.noteIds.length - result.moved;
      if (result.moved < ids.noteIds.length) firstError ??= "Some notes no longer exist.";
    } else {
      failed += ids.noteIds.length;
      firstError ??= result.error;
    }
  }
  for (const id of ids.folderIds) {
    const result = await moveFolder(session, id, destination);
    if (result.ok) done += 1;
    else {
      failed += 1;
      firstError ??= result.error;
    }
  }
  refresh();
  revalidatePath("/meetings/[id]", "page");
  if (done === 0) return { ok: false, error: firstError ?? "Nothing was moved." };
  return { ok: true, message: `Moved ${plural(done, "item", "items")}.`, done, failed, ...(firstError ? { error: firstError } : {}) };
}

/** Moves any mix of notes and folders to Trash. Notes go first so a folder and its own notes both restore cleanly. */
export async function trashItemsAction(formData: FormData): Promise<BulkResult> {
  const session = await requireSession();
  const ids = bulkIds(formData);
  if (!ids) return { ok: false, error: "Choose between 1 and 200 items." };
  let done = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const id of ids.noteIds) {
    const result = await trashNote(session, id);
    if (result.ok) done += 1;
    else {
      failed += 1;
      firstError ??= result.error;
    }
  }
  let folderNotes = 0;
  for (const id of ids.folderIds) {
    const result = await trashFolder(session, id);
    if (result.ok) {
      done += 1;
      folderNotes += result.notes;
    } else {
      failed += 1;
      firstError ??= result.error;
    }
  }
  refresh();
  if (done === 0) return { ok: false, error: firstError ?? "Nothing was deleted." };
  const extra = folderNotes > 0 ? ` (with ${plural(folderNotes, "note", "notes")})` : "";
  return { ok: true, message: `Moved ${plural(done, "item", "items")} to Trash${extra}.`, done, failed, ...(firstError ? { error: firstError } : {}) };
}

/** Undo for trashItemsAction: `items` are "note:<id>" / "folder:<id>" roots returned by the client. */
export async function restoreItemsAction(formData: FormData): Promise<BulkResult> {
  const session = await requireSession();
  const items = [...new Set(formData.getAll("item").map(String))].slice(0, MAX_BULK_ITEMS);
  let done = 0;
  let failed = 0;
  for (const item of items) {
    const [kind, ...rest] = item.split(":");
    const id = rest.join(":");
    if ((kind !== "note" && kind !== "folder") || !id) {
      failed += 1;
      continue;
    }
    const result = await restoreFromTrash(session, kind, id);
    if (result.ok) done += 1;
    else failed += 1;
  }
  refresh();
  if (done === 0) return { ok: false, error: "Couldn't restore. Open Trash to recover it." };
  return { ok: true, message: "Restored.", done, failed };
}
