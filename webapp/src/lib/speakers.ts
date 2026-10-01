import { prisma } from "./db";
import { speakerLabel } from "./types";
import { MAX_SPEAKER_NAME, MIN_SPEAKER_NAME, replaceLabel, validateSpeakerName, type RenameSpeakerResult } from "./speakers.shared";

export { MAX_SPEAKER_NAME, MIN_SPEAKER_NAME, replaceLabel, validateSpeakerName };
export type { RenameSpeakerResult };

/**
 * Names a speaker of a meeting (or resets it when `rawName` is empty or equals
 * the default label). The new name is written into the summary and action
 * items in place of the label that is currently there, and shown wherever the
 * transcript is shown. Transcript rows keep their stable keys.
 */
export async function renameSpeaker(workspaceId: string, meetingId: string, speakerKey: string, rawName: string): Promise<RenameSpeakerResult> {
  const defaultLabel = speakerLabel(speakerKey);
  const trimmed = rawName.replace(/\s+/g, " ").trim();
  const resetting = trimmed === "" || trimmed === defaultLabel;
  let targetLabel = defaultLabel;
  if (!resetting) {
    const checked = validateSpeakerName(trimmed);
    if ("error" in checked) return { ok: false, error: checked.error };
    targetLabel = checked.name;
  }

  return prisma.$transaction(async (tx) => {
    // Renames of one meeting run one at a time; the summary rewrite reads then writes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${meetingId}, 1))`;
    const meeting = await tx.meeting.findFirst({
      where: { id: meetingId, workspaceId, deletedAt: null },
      select: { summary: true, speakers: true, transcript: { select: { speaker: true }, distinct: ["speaker"] } },
    });
    if (!meeting) return { ok: false as const, error: "This meeting no longer exists." };
    const keys = meeting.transcript.map((line) => line.speaker);
    if (!keys.includes(speakerKey)) return { ok: false as const, error: "That speaker isn't in this transcript." };

    const names = new Map(meeting.speakers.map((row) => [row.speakerKey, row]));
    const labelOf = (key: string) => names.get(key)?.displayName ?? speakerLabel(key);
    const clash = keys.find((key) => key !== speakerKey && labelOf(key).toLowerCase() === targetLabel.toLowerCase());
    if (clash) return { ok: false as const, error: "Another speaker already has that name." };

    const current = names.get(speakerKey)?.appliedLabel ?? defaultLabel;
    if (current !== targetLabel) {
      await tx.meeting.update({ where: { id: meetingId }, data: { summary: replaceLabel(meeting.summary, current, targetLabel) } });
      const items = await tx.actionItem.findMany({ where: { meetingId }, select: { id: true, text: true, owner: true } });
      for (const item of items) {
        const text = replaceLabel(item.text, current, targetLabel);
        const owner = item.owner !== null && item.owner.trim().toLowerCase() === current.toLowerCase() ? targetLabel : item.owner;
        if (text !== item.text || owner !== item.owner) await tx.actionItem.update({ where: { id: item.id }, data: { text, owner } });
      }
    }
    if (resetting) {
      await tx.meetingSpeaker.deleteMany({ where: { meetingId, speakerKey } });
    } else {
      await tx.meetingSpeaker.upsert({
        where: { meetingId_speakerKey: { meetingId, speakerKey } },
        create: { meetingId, speakerKey, displayName: targetLabel, appliedLabel: targetLabel },
        update: { displayName: targetLabel, appliedLabel: targetLabel },
      });
    }
    return { ok: true as const, label: targetLabel };
  });
}

/** Names by speaker key for one meeting, in the shape speakerLabel() takes. */
export async function getSpeakerNames(workspaceId: string, meetingId: string): Promise<Record<string, string>> {
  const rows = await prisma.meetingSpeaker.findMany({ where: { meetingId, meeting: { workspaceId } }, select: { speakerKey: true, displayName: true } });
  return Object.fromEntries(rows.map((row) => [row.speakerKey, row.displayName]));
}
