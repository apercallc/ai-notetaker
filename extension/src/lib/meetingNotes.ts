import { speakerLabel, type MeetingRecord } from "../types";
import { describeBookmark } from "./bookmarks";

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function cleanTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Meeting";
}

function durationLabel(meeting: MeetingRecord): string {
  if (!meeting.endedAt) return "In progress";
  const durationMs = Math.max(0, Date.parse(meeting.endedAt) - Date.parse(meeting.startedAt));
  return `${Math.round(durationMs / 60_000)} minutes`;
}

export function driveTitle(meeting: MeetingRecord): string {
  return `${cleanTitle(meeting.title)} — ${dateOnly(meeting.startedAt)}`;
}

export function formatMeetingNotes(meeting: MeetingRecord): string {
  const attendees = meeting.attendees?.length ? meeting.attendees.join(", ") : "Not available";
  const actionItems = meeting.actionItems.length
    ? meeting.actionItems.map((item) => {
        const owner = item.owner ? ` — ${item.owner}` : "";
        const due = item.dueAt ? ` — due ${dateOnly(item.dueAt)}` : "";
        return `- [${item.status === "done" ? "x" : " "}] ${item.text}${owner}${due}`;
      })
    : ["_None recorded._"];
  const transcript = meeting.transcript.length
    ? meeting.transcript.map((segment) => `**${speakerLabel(segment.speaker)}:** ${segment.text}`)
    : ["_None recorded._"];

  return [
    `# ${meeting.title}`,
    "",
    `Date: ${new Date(meeting.startedAt).toLocaleString()}`,
    `Duration: ${durationLabel(meeting)}`,
    `Attendees: ${attendees}`,
    "",
    "## Summary",
    meeting.summary?.trim() || "_No summary available._",
    "",
    "## Key decisions",
    "_See the summary and discussion highlights._",
    "",
    "## Action items",
    ...actionItems,
    "",
    ...(meeting.bookmarks?.length ? ["## Flagged moments", ...meeting.bookmarks.map((bookmark) => `- ${describeBookmark(bookmark)}`), ""] : []),
    "## Discussion highlights",
    "_See the transcript below._",
    "",
    "## Open questions",
    "_None recorded._",
    "",
    "## Transcript",
    ...transcript,
    "",
  ].join("\n");
}
