"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/currentUser";
import { createFolder, moveFolder, moveNotes, renameFolder, trashFolder, trashNote } from "@/lib/library";
import { MAX_NOTE_UPLOAD_BYTES, createNote, isNoteUploadName, titleFromFileName } from "@/lib/noteEditing";

/**
 * Library actions. Expected failures come back as values, never thrown: Next
 * replaces the message of a thrown server-action error in production.
 */
export type LibraryResult = { ok: true; message?: string } | { ok: false; error: string };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");
const optionalId = (formData: FormData, name: string): string | null => text(formData, name).trim() || null;

function refresh(): void {
  revalidatePath("/meetings");
  revalidatePath("/trash");
}

export async function createFolderAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const result = await createFolder(session, optionalId(formData, "parentId"), text(formData, "name"));
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

export async function renameFolderAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const result = await renameFolder(session, text(formData, "id"), text(formData, "name"));
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

export async function moveFolderAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const result = await moveFolder(session, text(formData, "id"), optionalId(formData, "parentId"));
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

export async function moveNotesAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
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

export async function trashNoteAction(formData: FormData): Promise<LibraryResult> {
  const session = await requireSession();
  const result = await trashNote(session, text(formData, "id"));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Moved to Trash." };
}

/** Creates an empty note and opens it for typing. */
export async function createNoteAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const folderId = optionalId(formData, "folderId");
  const result = await createNote(session, { folderId, source: "manual" });
  if (!result.ok) redirect(`/meetings?${folderId ? `folder=${encodeURIComponent(folderId)}&` : ""}error=note-create-failed`);
  revalidatePath("/meetings");
  redirect(`/meetings/${result.id}?edit=1`);
}

/** The browser reads a small .md/.txt file and sends its text; nothing binary reaches the server. */
export async function uploadNoteAction(formData: FormData): Promise<LibraryResult & { id?: string }> {
  const session = await requireSession();
  const fileName = text(formData, "fileName");
  const body = text(formData, "body");
  if (!isNoteUploadName(fileName)) return { ok: false, error: "Upload a .md, .markdown or .txt file." };
  if (new TextEncoder().encode(body).length > MAX_NOTE_UPLOAD_BYTES) return { ok: false, error: `That file is too large. The limit is ${MAX_NOTE_UPLOAD_BYTES / 1024} KB.` };
  const result = await createNote(session, { title: titleFromFileName(fileName), body, folderId: optionalId(formData, "folderId"), source: "upload" });
  if (!result.ok) return result;
  refresh();
  return { ok: true, id: result.id };
}
