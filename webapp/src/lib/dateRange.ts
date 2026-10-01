export const MEETING_RANGES = [
  { id: "7d", label: "Past week", days: 7 },
  { id: "30d", label: "Past month", days: 30 },
  { id: "90d", label: "Past 3 months", days: 90 },
] as const;

export type MeetingRangeId = (typeof MEETING_RANGES)[number]["id"];

export function parseMeetingRange(raw: string | undefined): MeetingRangeId | undefined {
  return MEETING_RANGES.find((range) => range.id === raw)?.id;
}

/** Start of the window, or undefined for "all time". */
export function rangeStart(range: MeetingRangeId | undefined, now = new Date()): Date | undefined {
  const match = MEETING_RANGES.find((item) => item.id === range);
  return match ? new Date(now.getTime() - match.days * 86_400_000) : undefined;
}
