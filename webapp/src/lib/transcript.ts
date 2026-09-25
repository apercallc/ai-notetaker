// Pure helpers shared by the meeting detail page and the public share page.
// No Node-only imports: safe to use from client components too.

export interface TranscriptLine {
  speaker: string;
  text: string;
  timestamp: string; // ISO 8601
}

export interface TranscriptTurn {
  speaker: string;
  /** Seconds from meeting start to the first line of this turn, when trustworthy. */
  offsetSeconds: number | null;
  lines: string[];
}

// Timestamps have to spread over at least this long before they mean
// anything. Managed processing stamps every segment with the moment the
// worker finished, so they all land within milliseconds of each other and
// would otherwise render as a misleading wall of "45:00" offsets.
const MIN_SPREAD_MS = 1_000;
// Clock skew between the capture client and the server.
const END_SLACK_MS = 60_000;

/**
 * Seconds from meeting start for each line, or `null` when the timestamps
 * cannot be trusted as offsets (all identical, or outside the meeting).
 */
export function transcriptOffsets(startedAt: string, endedAt: string, lines: readonly TranscriptLine[]): (number | null)[] {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const times = lines.map((line) => Date.parse(line.timestamp));
  if (!Number.isFinite(start) || !Number.isFinite(end) || times.some((time) => !Number.isFinite(time))) {
    return lines.map(() => null);
  }
  if (times.length === 0 || Math.max(...times) - Math.min(...times) < MIN_SPREAD_MS) {
    return lines.map(() => null);
  }
  return times.map((time) => {
    if (time < start || time > end + END_SLACK_MS) return null;
    return Math.floor((time - start) / 1_000);
  });
}

/** `m:ss`, or `h:mm:ss` from one hour up. */
export function formatOffset(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Merge consecutive lines from one speaker into a single turn. */
export function groupTurns(startedAt: string, endedAt: string, lines: readonly TranscriptLine[]): TranscriptTurn[] {
  const offsets = transcriptOffsets(startedAt, endedAt, lines);
  const turns: TranscriptTurn[] = [];
  lines.forEach((line, index) => {
    const last = turns.at(-1);
    if (last && last.speaker === line.speaker) {
      last.lines.push(line.text);
      return;
    }
    turns.push({ speaker: line.speaker, offsetSeconds: offsets[index] ?? null, lines: [line.text] });
  });
  return turns;
}
