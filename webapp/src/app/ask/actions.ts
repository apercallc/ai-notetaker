"use server";

import { requireSession } from "@/lib/currentUser";
import { askWorkspaceNotes, type AskResult } from "@/lib/askRunner";

export type { AskResult };

export async function askNotesAction(question: string, folderId?: string | null): Promise<AskResult> {
  const { workspaceId } = await requireSession();
  return askWorkspaceNotes(workspaceId, question, folderId);
}
