// Pure helpers shared by the rename form (client) and the server. No database imports.

export const MIN_SPEAKER_NAME = 2;
export const MAX_SPEAKER_NAME = 60;
// Characters that would turn a name into markdown structure once it is written into the summary.
const UNSAFE_NAME = /[#*`<>[\]\\|\u0000-\u001f\u007f]/u;

export type RenameSpeakerResult = { ok: true; label: string } | { ok: false; error: string };

/** Collapses whitespace; returns an error message instead of a name when it is not usable. */
export function validateSpeakerName(raw: string): { name: string } | { error: string } {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < MIN_SPEAKER_NAME) return { error: `Use at least ${MIN_SPEAKER_NAME} characters.` };
  if (name.length > MAX_SPEAKER_NAME) return { error: `Use ${MAX_SPEAKER_NAME} characters or fewer.` };
  if (UNSAFE_NAME.test(name)) return { error: "Names can't contain # * ` < > [ ] | or backslashes." };
  return { name };
}

/**
 * Replaces `from` with `to` where `from` stands alone as a word, so "Them 1"
 * leaves "Them 10" and "Sam" leaves "Samuel" alone but still matches "Sam's".
 */
export function replaceLabel(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"), () => to);
}

