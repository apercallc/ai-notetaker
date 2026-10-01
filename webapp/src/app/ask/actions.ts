"use server";

import { requireSession } from "@/lib/currentUser";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { ChatUnavailableError } from "@/lib/chatQuota";
import { ChatBusyError, ChatProviderError, InvalidQuestionError, askNotes, type ChatAnswer } from "@/lib/notesChat";

export type AskResult = ({ ok: true } & ChatAnswer) | { ok: false; error: string };

export async function askNotesAction(question: string): Promise<AskResult> {
  const { workspaceId } = await requireSession();
  if (!managedHostingEnabled()) return { ok: false, error: "Ask your notes is available on the hosted service." };
  try {
    return { ok: true, ...(await askNotes(workspaceId, typeof question === "string" ? question : "")) };
  } catch (error) {
    if (error instanceof InvalidQuestionError || error instanceof ChatUnavailableError || error instanceof ChatBusyError) return { ok: false, error: error.message };
    if (error instanceof ChatProviderError) {
      console.error("notes chat provider failure", error.message);
      return { ok: false, error: "The assistant is unavailable right now. You were not charged a question; try again shortly." };
    }
    throw error;
  }
}
