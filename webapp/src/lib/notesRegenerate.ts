import { prisma } from "./db";
import { recordAudit } from "./audit";
import { managedHostingEnabled } from "./managedAuth";
import { ManagedWorkerError, formatSummaryText, summarize, type ManagedUtterance } from "./managedWorker";
import { MAX_NOTES_REGENERATIONS, NOTE_TEMPLATES, PICKABLE_TEMPLATES, isNoteTemplateId, noteTemplateFor } from "./noteTemplates";
import { hasProcessingAccess } from "./usageLedger";

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
export async function regenerateNotes(
  session: { workspaceId: string; userId: string },
  meetingId: string,
  templateId: string,
): Promise<RegenerateResult> {
  if (!managedHostingEnabled()) return fail("Hosted notes aren't enabled on this instance.");
  if (!isNoteTemplateId(templateId) || !PICKABLE_TEMPLATES.some((template) => template.id === templateId)) return fail("Choose one of the listed templates.");
  const template = NOTE_TEMPLATES[templateId];

  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: session.workspaceId },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      processingMode: true,
      notesRegenerations: true,
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
  if (!hasProcessingAccess(subscription)) return fail("Your plan has no hosted processing available. See Plans & usage.");

  // Claim one of the limited regenerations atomically so two clicks cannot both pass the check.
  const claimed = await prisma.meeting.updateMany({
    where: { id: meeting.id, workspaceId: session.workspaceId, notesRegenerations: { lt: MAX_NOTES_REGENERATIONS } },
    data: { notesRegenerations: { increment: 1 } },
  });
  if (claimed.count !== 1) return fail(`Notes can be regenerated ${MAX_NOTES_REGENERATIONS} times per meeting. You've used them all.`);

  const utterances: ManagedUtterance[] = meeting.transcript.map((segment) => {
    const offset = Math.max(0, segment.timestamp.getTime() - meeting.startedAt.getTime());
    return { speaker: segment.speaker, text: segment.text, startMs: offset, endMs: offset };
  });

  let summary;
  try {
    const speakerNames = Object.fromEntries(meeting.speakers.map((speaker) => [speaker.speakerKey, speaker.displayName]));
    ({ summary } = await summarize(utterances, meeting.startedAt.toISOString().slice(0, 10), noteTemplateFor(templateId), speakerNames));
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

  await prisma.$transaction(async (tx) => {
    await tx.meeting.update({ where: { id: meeting.id }, data: { summary: formatSummaryText(summary), mode: templateId } });
    const existing = await tx.actionItem.findMany({ where: { meetingId: meeting.id }, select: { text: true } });
    const known = new Set(existing.map((item) => item.text.trim().toLowerCase()));
    const fresh = summary.actionItems.filter((item) => !known.has(item.text.trim().toLowerCase()));
    if (fresh.length > 0) {
      await tx.actionItem.createMany({
        data: fresh.map((item) => ({ meetingId: meeting.id, userId: meeting.userId, text: item.text, owner: item.owner ?? null, dueAt: item.dueAt ?? null })),
      });
    }
  });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.regenerate_notes", targetType: "meeting", targetId: meeting.id, metadata: { template: templateId } });
  return { ok: true, template: templateId, remaining: Math.max(0, MAX_NOTES_REGENERATIONS - meeting.notesRegenerations - 1) };
}
