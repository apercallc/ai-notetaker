import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { recordAudit } from "./audit";
import type { Fail, LibrarySession } from "./library";

import { MAX_NOTE_BODY, MAX_NOTE_TITLE, MAX_NOTE_UPLOAD_BYTES, NOTE_UPLOAD_EXTENSIONS } from "./noteEditing.shared";

export { MAX_NOTE_BODY, MAX_NOTE_TITLE, MAX_NOTE_UPLOAD_BYTES, NOTE_UPLOAD_EXTENSIONS };

const fail = (error: string): Fail => ({ ok: false, error });

/** Text only: no NUL bytes, bounded length. Line endings are normalised to \n. */
export function validateNoteBody(raw: string): { body: string } | { error: string } {
  if (raw.includes("\u0000")) return { error: "This doesn't look like a text file." };
  const body = raw.replace(/\r\n?/g, "\n");
  if (body.length > MAX_NOTE_BODY) return { error: `Notes can be up to ${MAX_NOTE_BODY.toLocaleString("en-US")} characters.` };
  return { body };
}

/** "Quarterly plan.md" → "Quarterly plan". */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(md|markdown|txt)$/i, "").replace(/\s+/g, " ").trim();
  return (base || "Untitled note").slice(0, MAX_NOTE_TITLE);
}

export function isNoteUploadName(fileName: string): boolean {
  return new RegExp(`\\.(${NOTE_UPLOAD_EXTENSIONS.join("|")})$`, "i").test(fileName.trim());
}

/**
 * Creates a note by hand or from an uploaded text file. It has no transcript
 * and no recording behind it, so it is never sent to a provider and cannot be
 * regenerated; it is just text in the library.
 */
export async function createNote(
  session: LibrarySession,
  input: { title?: string; body?: string; folderId?: string | null; source: "manual" | "upload" },
): Promise<{ ok: true; id: string } | Fail> {
  const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_TITLE) || "Untitled note";
  const checked = validateNoteBody(input.body ?? "");
  if ("error" in checked) return fail(checked.error);
  const folderId = input.folderId ?? null;
  if (folderId && !(await prisma.folder.findFirst({ where: { id: folderId, workspaceId: session.workspaceId, deletedAt: null }, select: { id: true } }))) {
    return fail("That folder no longer exists.");
  }
  const now = new Date();
  const id = randomUUID();
  await prisma.meeting.create({
    data: {
      id,
      userId: session.userId,
      workspaceId: session.workspaceId,
      title,
      summary: checked.body,
      mode: "general",
      captureSource: "manual",
      processingMode: "local_byok",
      startedAt: now,
      endedAt: now,
      folderId,
    },
  });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.create", targetType: "meeting", targetId: id, metadata: { source: input.source } });
  return { ok: true, id };
}

export type SaveBodyResult = { ok: true; version: string } | Fail | { ok: false; conflict: true; error: string };

/**
 * Saves a hand-edited note body. `expectedVersion` is the version the editor
 * loaded; if the note changed since (another tab, another person, a rename),
 * nothing is overwritten and the caller is told to reload. The replaced text
 * is kept once as `previousSummary` so the edit can be undone.
 */
export async function updateNoteBody(session: LibrarySession, meetingId: string, rawBody: string, expectedVersion: string): Promise<SaveBodyResult> {
  const checked = validateNoteBody(rawBody);
  if ("error" in checked) return fail(checked.error);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${meetingId}, 2))`;
    const note = await tx.meeting.findFirst({ where: { id: meetingId, workspaceId: session.workspaceId, deletedAt: null }, select: { summary: true, updatedAt: true } });
    if (!note) return fail("This note no longer exists.");
    if (note.updatedAt.toISOString() !== expectedVersion) {
      return { ok: false as const, conflict: true as const, error: "This note changed while you were editing. Copy your text, reload, and try again." };
    }
    if (note.summary === checked.body) return { ok: true as const, version: note.updatedAt.toISOString() };
    const updated = await tx.meeting.update({
      where: { id: meetingId },
      data: { summary: checked.body, previousSummary: note.summary, summaryEditedAt: new Date() },
      select: { updatedAt: true },
    });
    return { ok: true as const, version: updated.updatedAt.toISOString(), edited: true };
  });
  // Outside the transaction: a failed audit write must never abort the save.
  if (result.ok && "edited" in result) await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.edit", targetType: "meeting", targetId: meetingId });
  return result.ok ? { ok: true, version: result.version } : result;
}

/** Swaps the body with the one it replaced (an edit or a regeneration); doing it again swaps back. */
export async function restorePreviousBody(session: LibrarySession, meetingId: string): Promise<{ ok: true; version: string } | Fail> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${meetingId}, 2))`;
    const note = await tx.meeting.findFirst({ where: { id: meetingId, workspaceId: session.workspaceId, deletedAt: null }, select: { summary: true, previousSummary: true } });
    if (!note) return fail("This note no longer exists.");
    if (note.previousSummary === null) return fail("There's no earlier version to restore.");
    const updated = await tx.meeting.update({
      where: { id: meetingId },
      data: { summary: note.previousSummary, previousSummary: note.summary, summaryEditedAt: new Date() },
      select: { updatedAt: true },
    });
    return { ok: true as const, version: updated.updatedAt.toISOString() };
  });
  if (result.ok) await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.edit", targetType: "meeting", targetId: meetingId, metadata: { restored: true } });
  return result;
}
