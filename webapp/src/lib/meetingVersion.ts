/** Return a strictly increasing version time even when edits land in one clock millisecond. */
export function nextMeetingVersion(previous: Date, now = new Date()): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}
