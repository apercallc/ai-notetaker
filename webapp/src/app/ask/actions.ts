"use server";

import { requireSession } from "@/lib/currentUser";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { ChatUnavailableError } from "@/lib/chatQuota";
import { listFolders } from "@/lib/library";
import { subtreeIds } from "@/lib/libraryTree";
import { ChatBusyError, ChatProviderError, InvalidQuestionError, askNotes, type ChatAnswer } from "@/lib/notesChat";

export type AskResult = ({ ok: true } & ChatAnswer) | { ok: false; error: string };

export async function askNotesAction(question: string, folderId?: string | null): Promise<AskResult> {
  const { workspaceId } = await requireSession();
  if (!managedHostingEnabled()) return { ok: false, error: "Ask your notes is available on the hosted service." };
  try {
    // An optional library scope: only notes in this folder and the folders inside it.
    let folderIds: string[] | undefined;
    if (typeof folderId === "string" && folderId) {
      const folders = await listFolders(workspaceId);
      if (!folders.some((folder) => folder.id === folderId)) return { ok: false, error: "That folder isn't available any more. Choose another or ask across your whole library." };
      folderIds = subtreeIds(folders, folderId);
    }
    return { ok: true, ...(await askNotes(workspaceId, typeof question === "string" ? question : "", folderIds)) };
  } catch (error) {
    if (error instanceof InvalidQuestionError || error instanceof ChatUnavailableError || error instanceof ChatBusyError) return { ok: false, error: error.message };
    if (error instanceof ChatProviderError) {
      console.error("notes chat provider failure", error.message);
      return { ok: false, error: "The assistant is unavailable right now. You were not charged a question; try again shortly." };
    }
    // An unexpected failure (database blip, bug) must not reach the client as Next's masked, blank error.
    console.error("notes chat failed", error instanceof Error ? error.message : String(error));
    return { ok: false, error: "Something went wrong answering that. Try again in a moment." };
  }
}
