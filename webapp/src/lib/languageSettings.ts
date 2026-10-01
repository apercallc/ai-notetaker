import { prisma } from "./db";
import { recordAudit } from "./audit";
import { MAX_VOCABULARY_TERMS, isLanguageCode, parseVocabulary } from "./languages";
import type { Fail, LibrarySession } from "./library";

/**
 * Workspace-wide transcription vocabulary and the language notes are written in.
 * Owners only. Terms are normalised (see parseVocabulary) and stored one per line.
 */
export async function updateLanguageSettings(
  session: LibrarySession,
  input: { vocabulary: string; summaryLanguage: string },
): Promise<{ ok: true; terms: number } | Fail> {
  if (session.role !== "owner") return { ok: false, error: "Only a workspace owner can change these settings." };
  if (input.vocabulary.length > 20_000) return { ok: false, error: "That list is too long." };
  const summaryLanguage = input.summaryLanguage.trim();
  if (summaryLanguage && !isLanguageCode(summaryLanguage)) return { ok: false, error: "Choose one of the listed languages." };
  const terms = parseVocabulary(input.vocabulary);
  if (input.vocabulary.trim() && terms.length === 0) return { ok: false, error: "Enter names or terms, one per line." };
  await prisma.workspace.update({ where: { id: session.workspaceId }, data: { vocabulary: terms.join("\n"), summaryLanguage: summaryLanguage || null } });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "workspace.language_update", targetType: "workspace", targetId: session.workspaceId, metadata: { terms: terms.length, language: summaryLanguage || "same" } });
  return { ok: true, terms: terms.length };
}

export { MAX_VOCABULARY_TERMS };
