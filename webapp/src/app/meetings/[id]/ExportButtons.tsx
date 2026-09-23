"use client";

import { speakerLabel, type MeetingDetailResponse } from "@/lib/types";

function safeFilename(title: string, extension: string): string {
  const normalized = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "meeting";
  return `${normalized}.${extension}`;
}

function markdownFor(meeting: MeetingDetailResponse): string {
  return [
    `# ${meeting.title}`,
    "",
    `Started: ${meeting.startedAt}`,
    `Ended: ${meeting.endedAt}`,
    `Mode: ${meeting.mode.replaceAll("_", " ")}`,
    "",
    "## Summary",
    meeting.summary || "_No summary available._",
    "",
    "## Action Items",
    ...(meeting.actionItems.length
      ? meeting.actionItems.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.text}${item.owner ? ` (${item.owner})` : ""}${item.dueAt ? ` — due ${item.dueAt.slice(0, 10)}` : ""}`)
      : ["_None_"]),
    "",
    "## Transcript",
    ...meeting.transcript.map((segment) => `**${speakerLabel(segment.speaker)}:** ${segment.text}`),
  ].join("\n");
}

function plainTextFor(meeting: MeetingDetailResponse): string {
  return [
    meeting.title,
    `Started: ${meeting.startedAt}`,
    `Ended: ${meeting.endedAt}`,
    `Mode: ${meeting.mode.replaceAll("_", " ")}`,
    "",
    "SUMMARY",
    meeting.summary || "No summary available.",
    "",
    "ACTION ITEMS",
    ...(meeting.actionItems.length
      ? meeting.actionItems.map((item) => `${item.status === "done" ? "[done]" : "[open]"} ${item.text}${item.owner ? ` (${item.owner})` : ""}${item.dueAt ? ` — due ${item.dueAt.slice(0, 10)}` : ""}`)
      : ["None"]),
    "",
    "TRANSCRIPT",
    ...meeting.transcript.map((segment) => `${speakerLabel(segment.speaker)}: ${segment.text}`),
  ].join("\n");
}

function download(meeting: MeetingDetailResponse, contents: string, extension: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename(meeting.title, extension);
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 0);
}

export function ExportButtons({ meeting }: { meeting: MeetingDetailResponse }) {
  return (
    <div className="export-actions" aria-label="Export meeting">
      <button type="button" className="button button-secondary" onClick={() => download(meeting, markdownFor(meeting), "md", "text/markdown")}>
        Markdown
      </button>
      <button type="button" className="button button-secondary" onClick={() => download(meeting, plainTextFor(meeting), "txt", "text/plain")}>
        Plain text
      </button>
      <button type="button" className="button button-secondary" onClick={() => window.print()}>
        Print / Save PDF
      </button>
    </div>
  );
}
