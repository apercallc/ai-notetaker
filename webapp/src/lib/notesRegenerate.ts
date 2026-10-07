import { prisma } from "./db";
import { nextMeetingVersion } from "./meetingVersion";
import { recordAudit } from "./audit";
import { hostedAiEnabled } from "./deploymentConfig";
import { managedHostingEnabled } from "./managedAuth";
import { ManagedWorkerError, formatSummaryText, summarize, type ManagedUtterance } from "./managedWorker";
import { MAX_NOTES_REGENERATIONS, NOTE_TEMPLATES, PICKABLE_TEMPLATES, isNoteTemplateId, noteTemplateFor } from "./noteTemplates";
import { hasProcessingAccess } from "./usageLedger";
import { isLanguageCode, parseVocabulary } from "./languages";
import { withProviderSpend } from "./providerSpend";

export type RegenerateResult =
  | { ok: true; template: string; remaining: number }
  | { ok: false; error: string };

const fail = (error: string): RegenerateResult => ({ ok: false, error });

/**
 * Rewrites a hosted meeting's summary from its stored transcript using the
 * chosen template. No audio is involved, so there is no usage reservation; the
 * cost is one summary call, bounded by MAX_NOTES_REGENERATIONS per meeting.
 * Action items are never deleted (people tick them off and set due dates):
 * new ones are added only when their text is not already present.
 */
class RegenerateConflictError extends Error {}

export async function regenerateNotes(
  session: { workspaceId: string; userId: string },
  meetingId: string,
  templateId: string,
  options: { summaryLanguage?: string } = {},
): Promise<RegenerateResult> {
  if (!managedHostingEnabled() || !hostedAiEnabled()) return fail("Rewriting notes with a template isn't offered.");
  if (!isNoteTemplateId(templateId) || !PICKABLE_TEMPLATES.some((template) => template.id === templateId)) return fail("Choose one of the listed templates.");
  const template = NOTE_TEMPLATES[templateId];
  if (options.summaryLanguage && !isLanguageCode(options.summaryLanguage)) return fail("Choose one of the listed languages.");

  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: session.workspaceId, deletedAt: null },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      processingMode: true,
      notesRegenerations: true,
      summary: true,
      summaryEditedAt: true,
      transcript: { orderBy: { order: "asc" }, select: { speaker: true, text: true, timestamp: true } },
      speakers: { select: { speakerKey: true, displayName: true } },
      processingJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
    },
  });
  if (!meeting) return fail("This meeting no longer exists.");
  if (meeting.processingMode !== "managed") return fail("Only notes made by the hosted service can be regenerated.");
  const latest = meeting.processingJobs[0]?.status;
  if (latest === "queued" || latest === "processing") return fail("This meeting is still being processed. Try again when it's ready.");
  if (meeting.transcript.length === 0) return fail("There's no transcript to write notes from.");

  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId: session.workspaceId } });
  if (!hasProcessingAccess(subscription)) return fail("Hosted processing isn't offered. Your audio stays on your desktop.");

  // Claim one of the limited regenerations atomically so two clicks cannot both pass the check.
  const claimed = await prisma.meeting.updateMany({
    where: { id: meeting.id, workspaceId: session.workspaceId, notesRegenerations: { lt: MAX_NOTES_REGENERATIONS } },
    data: { notesRegenerations: { increment: 1 } },
  });
  if (claimed.count !== 1) return fail(`Notes can be regenerated ${MAX_NOTES_REGENERATIONS} times per meeting. You've used them all.`);

  const utterances: ManagedUtterance[] = meeting.transcript.map((segment) => {
    const offset = segment.timestamp
      ? Math.max(0, segment.timestamp.getTime() - meeting.startedAt.getTime())
      : 0;
    return { speaker: segment.speaker, text: segment.text, startMs: offset, endMs: offset };
  });

  let summary;
  try {
    const vocabulary = (await prisma.workspace.findUnique({ where: { id: session.workspaceId }, select: { vocabulary: true } }))?.vocabulary ?? "";
    const speakerNames = Object.fromEntries(meeting.speakers.map((speaker) => [speaker.speakerKey, speaker.displayName]));
    ({ summary } = await withProviderSpend(session.workspaceId, `regenerate:${meeting.id}`, () => summarize(utterances, meeting.startedAt.toISOString().slice(0, 10), noteTemplateFor(templateId), speakerNames, { language: options.summaryLanguage || null, vocabulary: parseVocabulary(vocabulary) })));
  } catch (error) {
    // A failed attempt must not use up one of the three.
    await prisma.meeting.updateMany({ where: { id: meeting.id, notesRegenerations: { gt: 0 } }, data: { notesRegenerations: { decrement: 1 } } });
    // Provider errors are user-safe, but a missing-credential message names a
    // server setting. Log that for operators and show a neutral line instead.
    const detail = error instanceof Error ? error.message : String(error);
    const userSafe = error instanceof ManagedWorkerError && !/not configured/i.test(detail);
    if (!userSafe) console.error("notes regeneration failed", { meetingId: meeting.id, error: detail });
    return fail(userSafe ? detail : "Couldn't regenerate the notes. Try again in a moment.");
  }

  // A regeneration can take a while; the user may edit the note meanwhile. Never overwrite
  // a newer hand edit with notes written from older text.
  const refund = () => prisma.meeting.updateMany({ where: { id: meeting.id, notesRegenerations: { gt: 0 } }, data: { notesRegenerations: { decrement: 1 } } }).catch(() => undefined);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Meeting" WHERE "id" = ${meeting.id} FOR UPDATE`;
      const current = await tx.meeting.findUniqueOrThrow({ where: { id: meeting.id }, select: { summary: true, summaryEditedAt: true, updatedAt: true } });
      if (current.summary !== meeting.summary || current.summaryEditedAt?.getTime() !== meeting.summaryEditedAt?.getTime()) {
        throw new RegenerateConflictError();
      }
      // Keep what was there once, so a regeneration can be undone like a hand edit.
      await tx.meeting.update({
        where: { id: meeting.id },
        data: {
          summary: formatSummaryText(summary),
          mode: templateId,
          previousSummary: current.summary,
          summaryEditedAt: null,
          updatedAt: nextMeetingVersion(current.updatedAt),
        },
      });
      const existing = await tx.actionItem.findMany({ where: { meetingId: meeting.id }, select: { text: true } });
      const known = new Set(existing.map((item) => item.text.trim().toLowerCase()));
      const fresh = summary.actionItems.filter((item) => !known.has(item.text.trim().toLowerCase()));
      if (fresh.length > 0) {
        await tx.actionItem.createMany({
          data: fresh.map((item) => ({ meetingId: meeting.id, userId: meeting.userId, text: item.text, owner: item.owner ?? null, dueAt: item.dueAt ?? null })),
        });
      }
    }, { timeout: 15_000 });
  } catch (error) {
    await refund();
    if (error instanceof RegenerateConflictError) return fail("This note was edited while the new version was being written, so nothing was changed. Try again.");
    console.error("notes regeneration could not be saved", { meetingId: meeting.id, error: error instanceof Error ? error.message : String(error) });
    return fail("Couldn't save the regenerated notes. Try again in a moment.");
  }
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.regenerate_notes", targetType: "meeting", targetId: meeting.id, metadata: { template: templateId } });
  return { ok: true, template: templateId, remaining: Math.max(0, MAX_NOTES_REGENERATIONS - meeting.notesRegenerations - 1) };
}
