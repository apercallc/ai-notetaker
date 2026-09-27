import { escapeHtml } from "../lib/html";
import { describeBookmark } from "../lib/bookmarks";
import { speakerLabel, type ActionItem, type MeetingRecord } from "../types";

export type SummarySectionKind = "overview" | "key_points" | "decisions" | "action_items" | "other";

export interface SummarySection {
  kind: SummarySectionKind;
  title: string;
  blocks: Array<{ type: "p" | "li"; text: string }>;
}

const KIND_PATTERNS: Array<[SummarySectionKind, RegExp]> = [
  ["overview", /^(overview|summary|tl;?dr|at a glance|meeting summary)$/],
  ["key_points", /^(key points|highlights|discussion( points| highlights)?|main points|topics( discussed)?|key takeaways|takeaways)$/],
  ["decisions", /^((key )?decisions( made)?)$/],
  ["action_items", /^(action items|next steps|follow[- ]?ups?|to-?dos?)$/],
];

const KIND_TITLES: Record<Exclude<SummarySectionKind, "other">, string> = {
  overview: "Overview",
  key_points: "Key points",
  decisions: "Decisions",
  action_items: "Action items",
};

const BULLET = /^\s*(?:[-*•]|\d{1,3}[.)])\s+(.*)$/;

function stripEmphasis(value: string): string {
  return value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim();
}

/** Returns the heading text if the line looks like a section heading, else null. */
function headingText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || BULLET.test(trimmed)) return null;
  const markdown = trimmed.match(/^#{1,6}\s+(.+?)\s*#*$/);
  if (markdown) return stripEmphasis(markdown[1]!).replace(/:$/, "");
  const bold = trimmed.match(/^\*\*(.+?)\*\*:?$/) ?? trimmed.match(/^__(.+?)__:?$/);
  if (bold) return bold[1]!.replace(/:$/, "").trim();
  const colon = trimmed.match(/^([A-Za-z][A-Za-z &/-]{1,38}):$/);
  if (colon) return colon[1]!.trim();
  if (/^[A-Z][A-Z &/-]{3,38}$/.test(trimmed)) return trimmed;
  return null;
}

function kindFor(title: string): SummarySectionKind {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
  return KIND_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? "other";
}

/**
 * Splits a summary into overview / key points / decisions / action items when
 * the text carries recognizable headings. Returns null for plain prose so the
 * caller can fall back to showing it verbatim: a summary is never rewritten
 * or dropped, only laid out.
 */
export function parseSummary(summary: string): SummarySection[] | null {
  const lines = summary.replace(/\r\n?/g, "\n").split("\n");
  const sections: SummarySection[] = [];
  let current: SummarySection | null = null;
  let recognized = 0;

  const open = (kind: SummarySectionKind, title: string): SummarySection => {
    const section: SummarySection = { kind, title, blocks: [] };
    sections.push(section);
    return section;
  };

  for (const line of lines) {
    const heading = headingText(line);
    if (heading) {
      const kind = kindFor(heading);
      if (kind !== "other") recognized += 1;
      current = open(kind, kind === "other" ? heading : KIND_TITLES[kind]);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!current) current = open("overview", KIND_TITLES.overview);
    const bullet = trimmed.match(BULLET);
    current.blocks.push(bullet ? { type: "li", text: stripEmphasis(bullet[1]!) } : { type: "p", text: stripEmphasis(trimmed) });
  }

  const populated = sections.filter((section) => section.blocks.length > 0);
  return recognized > 0 && populated.length > 0 ? populated : null;
}

function renderBlocks(blocks: SummarySection["blocks"]): string {
  let html = "";
  let list: string[] = [];
  const flush = (): void => {
    if (list.length > 0) html += `<ul>${list.join("")}</ul>`;
    list = [];
  };
  for (const block of blocks) {
    if (block.type === "li") {
      list.push(`<li>${escapeHtml(block.text)}</li>`);
    } else {
      flush();
      html += `<p>${escapeHtml(block.text)}</p>`;
    }
  }
  flush();
  return html;
}

/**
 * HTML for the summary. Every piece of text is escaped: summaries are model
 * output and must never be able to inject markup. `hideActionItems` drops the
 * summary's own action-item section when the interactive list is shown below.
 */
export function renderSummaryHtml(summary: string, options: { hideActionItems?: boolean } = {}): string {
  const sections = parseSummary(summary);
  if (!sections) return `<p class="summary-plain">${escapeHtml(summary)}</p>`;
  return sections
    .filter((section) => !(options.hideActionItems && section.kind === "action_items"))
    .map((section) => `<div class="summary-section" data-kind="${section.kind}"><h3>${escapeHtml(section.title)}</h3>${renderBlocks(section.blocks)}</div>`)
    .join("");
}

/** Collapses line breaks and control characters so a title can never inject structure into an export. */
export function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(new RegExp("[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+", "g"), " ").replace(/\s+/g, " ").trim();
}

export function displayTitle(meeting: Pick<MeetingRecord, "title">): string {
  return singleLine(meeting.title) || "Untitled meeting";
}

function actionLine(item: ActionItem, style: "markdown" | "text"): string {
  const done = item.status === "done";
  const owner = item.owner ? ` (${singleLine(item.owner)})` : "";
  const due = item.dueAt ? ` — due ${item.dueAt.slice(0, 10)}` : "";
  const text = singleLine(item.text);
  return style === "markdown" ? `- [${done ? "x" : " "}] ${text}${owner}${due}` : `${done ? "[done]" : "[open]"} ${text}${owner}${due}`;
}

export function formatActionItemsForCopy(meeting: Pick<MeetingRecord, "actionItems">): string {
  return meeting.actionItems.map((item) => actionLine(item, "markdown")).join("\n");
}

/** The notes without the transcript: what people paste into a doc or chat. */
export function formatNotesForCopy(meeting: MeetingRecord): string {
  return [
    `# ${displayTitle(meeting)}`,
    "",
    `Date: ${new Date(meeting.startedAt).toLocaleString()}`,
    "",
    "## Summary",
    meeting.summary?.trim() || "_No summary available._",
    "",
    "## Action items",
    ...(meeting.actionItems.length > 0 ? meeting.actionItems.map((item) => actionLine(item, "markdown")) : ["_None_"]),
  ].join("\n");
}

export function exportAsMarkdown(meeting: MeetingRecord): string {
  const lines = [
    `# ${displayTitle(meeting)}`,
    "",
    `Started: ${meeting.startedAt}`,
    "",
    "## Summary",
    meeting.summary ?? "_No summary available._",
    "",
    "## Action Items",
    ...(meeting.actionItems.length > 0 ? meeting.actionItems.map((item) => actionLine(item, "markdown")) : ["_None_"]),
    "",
    ...(meeting.bookmarks?.length ? ["## Flagged moments", ...meeting.bookmarks.map((bookmark) => `- ${describeBookmark(bookmark)}`), ""] : []),
    "## Transcript",
    ...meeting.transcript.map((segment) => `**${speakerLabel(segment.speaker)}:** ${segment.text}`),
  ];
  return lines.join("\n");
}

export function exportAsPlainText(meeting: MeetingRecord): string {
  const lines = [
    displayTitle(meeting),
    `Started: ${new Date(meeting.startedAt).toLocaleString()}`,
    "",
    "SUMMARY",
    meeting.summary ?? "No summary available.",
    "",
    "ACTION ITEMS",
    ...(meeting.actionItems.length > 0 ? meeting.actionItems.map((item) => actionLine(item, "text")) : ["None"]),
    "",
    ...(meeting.bookmarks?.length ? ["FLAGGED MOMENTS", ...meeting.bookmarks.map(describeBookmark), ""] : []),
    "TRANSCRIPT",
    ...meeting.transcript.map((segment) => `${speakerLabel(segment.speaker)}: ${segment.text}`),
  ];
  return lines.join("\n");
}

export function exportFileName(meeting: Pick<MeetingRecord, "title">, extension: string): string {
  return `${displayTitle(meeting).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "meeting"}.${extension}`;
}
