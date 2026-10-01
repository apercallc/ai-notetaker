"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/currentUser";
import { deleteForever, emptyTrash, restoreFromTrash, type TrashKind } from "@/lib/library";

export type TrashResult = { ok: true; message: string } | { ok: false; error: string };

const kindOf = (formData: FormData): TrashKind => (formData.get("kind") === "folder" ? "folder" : "note");

function refresh(): void {
  revalidatePath("/trash");
  revalidatePath("/meetings");
  revalidatePath("/actions");
}

export async function restoreAction(formData: FormData): Promise<TrashResult> {
  const session = await requireSession();
  const result = await restoreFromTrash(session, kindOf(formData), String(formData.get("id") ?? ""));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Restored." };
}

export async function deleteForeverAction(formData: FormData): Promise<TrashResult> {
  const session = await requireSession();
  const result = await deleteForever(session, kindOf(formData), String(formData.get("id") ?? ""));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Deleted forever." };
}

export async function emptyTrashAction(): Promise<TrashResult> {
  const session = await requireSession();
  const result = await emptyTrash(session);
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: result.removed === 0 ? "The trash was already empty." : "Trash emptied." };
}
