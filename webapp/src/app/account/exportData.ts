import { prisma } from "@/lib/db";

/**
 * Streaming export of every meeting in ONE workspace, as JSON with both a
 * readable markdown rendering and the raw transcript segments. Tenant-
 * scoped: the only input is a workspaceId the caller has already verified
 * membership for, and every query repeats it.
 *
 * Keyset pagination (startedAt, id) — offset paging could skip or repeat a
 * meeting when a sync inserts rows mid-export; a keyset can't.
 */

export interface ExportedTranscriptSegment {
  speaker: string;
  text: string;
  timestamp: string;
}

export interface ExportedActionItem {
  text: string;
  owner: string | null;
  status: string;
  dueAt: string | null;
}

export interface ExportedMeeting {
  id: string;
  title: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  summary: string | null;
  markdown: string;
  transcript: ExportedTranscriptSegment[];
  actionItems: ExportedActionItem[];
}

const BATCH_SIZE = 50;

function formatTime(timestamp: Date, startedAt: Date): string {
  const totalSeconds = Math.max(0, Math.round((timestamp.getTime() - startedAt.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function meetingToMarkdown(row: {
  title: string;
  mode: string;
  startedAt: Date;
  endedAt: Date;
  summary: string | null;
  transcript: Array<{ speaker: string; text: string; timestamp: Date }>;
  actionItems: Array<{ text: string; owner: string | null; status: string; dueAt: Date | null }>;
}): string {
  const lines: string[] = [
    `# ${row.title}`,
    "",
    `- Recorded: ${row.startedAt.toISOString()}`,
    `- Ended: ${row.endedAt.toISOString()}`,
    `- Mode: ${row.mode}`,
    "",
  ];
  if (row.summary) lines.push("## Summary", "", row.summary, "");
  if (row.actionItems.length > 0) {
    lines.push("## Action items", "");
    for (const item of row.actionItems) {
      const parts = [item.text];
      if (item.owner) parts.push(`(owner: ${item.owner})`);
      if (item.dueAt) parts.push(`(due: ${item.dueAt.toISOString().slice(0, 10)})`);
      lines.push(`- ${item.status === "done" ? "[x]" : "[ ]"} ${parts.join(" ")}`);
    }
    lines.push("");
  }
  if (row.transcript.length > 0) {
    lines.push("## Transcript", "");
    for (const segment of row.transcript) {
      lines.push(`**[${formatTime(segment.timestamp, row.startedAt)}] ${segment.speaker}:** ${segment.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function toExportedMeeting(row: {
  id: string;
  title: string;
  mode: string;
  startedAt: Date;
  endedAt: Date;
  summary: string | null;
  transcript: Array<{ speaker: string; text: string; timestamp: Date }>;
  actionItems: Array<{ text: string; owner: string | null; status: string; dueAt: Date | null }>;
}): ExportedMeeting {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    summary: row.summary,
    markdown: meetingToMarkdown(row),
    transcript: row.transcript.map((segment) => ({
      speaker: segment.speaker,
      text: segment.text,
      timestamp: segment.timestamp.toISOString(),
    })),
    actionItems: row.actionItems.map((item) => ({
      text: item.text,
      owner: item.owner,
      status: item.status,
      dueAt: item.dueAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Yields the workspace's meetings in export form, `BATCH_SIZE` at a time,
 * newest first. Never holds more than one batch in memory so a huge archive
 * exports without the request ballooning.
 */
export async function* streamWorkspaceMeetings(
  workspaceId: string,
): AsyncGenerator<ExportedMeeting[], void, void> {
  let cursor: { startedAt: Date; id: string } | null = null;
  // Bounded: each pass strictly advances the (startedAt, id) keyset.
  for (;;) {
    const rows: Array<Parameters<typeof toExportedMeeting>[0]> = await prisma.meeting.findMany({
      where: {
        workspaceId,
        ...(cursor
          ? { OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: BATCH_SIZE,
      select: {
        id: true,
        title: true,
        mode: true,
        startedAt: true,
        endedAt: true,
        summary: true,
        transcript: { orderBy: { order: "asc" }, select: { speaker: true, text: true, timestamp: true } },
        actionItems: { orderBy: { id: "asc" }, select: { text: true, owner: true, status: true, dueAt: true } },
      },
    });
    if (rows.length === 0) return;
    yield rows.map(toExportedMeeting);
    const last: { startedAt: Date; id: string } | undefined = rows[rows.length - 1];
    if (!last || rows.length < BATCH_SIZE) return;
    cursor = { startedAt: last.startedAt, id: last.id };
  }
}

export interface WorkspaceExportHeader {
  workspace: { id: string; name: string };
  exportedAt: string;
}

export function exportHeader(workspaceId: string, workspaceName: string, now: Date = new Date()): WorkspaceExportHeader {
  return { workspace: { id: workspaceId, name: workspaceName }, exportedAt: now.toISOString() };
}

export function exportFileName(workspaceName: string, now: Date = new Date()): string {
  const slug = workspaceName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
  return `notetaker-export-${slug}-${now.toISOString().slice(0, 10)}.json`;
}
