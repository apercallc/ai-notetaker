/**
 * Languages offered for spoken-language hints and for the language notes are
 * written in. Dependency-free (shared by forms and the worker). Codes are
 * ISO 639-1, which both Whisper and Deepgram accept.
 */
export const LANGUAGES = [
  ["ar", "Arabic"], ["zh", "Chinese"], ["cs", "Czech"], ["da", "Danish"], ["nl", "Dutch"], ["en", "English"],
  ["fi", "Finnish"], ["fr", "French"], ["de", "German"], ["el", "Greek"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["no", "Norwegian"], ["pl", "Polish"],
  ["pt", "Portuguese"], ["ru", "Russian"], ["es", "Spanish"], ["sv", "Swedish"], ["tr", "Turkish"], ["uk", "Ukrainian"],
  ["vi", "Vietnamese"],
] as const;

export type LanguageCode = (typeof LANGUAGES)[number][0];

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && LANGUAGES.some(([code]) => code === value);
}

export function languageName(code: string | null | undefined): string | null {
  return LANGUAGES.find(([candidate]) => candidate === code)?.[1] ?? null;
}

/** Whisper reports the language as an English name ("spanish"); returns our code, or null if unknown. */
export function languageCodeFromName(name: unknown): LanguageCode | null {
  if (typeof name !== "string") return null;
  const wanted = name.trim().toLowerCase();
  if (wanted === "mandarin") return "zh";
  return LANGUAGES.find(([, label]) => label.toLowerCase() === wanted)?.[0] ?? (isLanguageCode(wanted) ? wanted : null);
}

export const MAX_VOCABULARY_TERMS = 100;
export const MAX_VOCABULARY_TERM_LENGTH = 40;

/** One term per line or comma; trims, drops control characters and duplicates, and bounds count and length. */
export function parseVocabulary(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[\n,;]/)) {
    const term = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_VOCABULARY_TERM_LENGTH);
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
    if (terms.length >= MAX_VOCABULARY_TERMS) break;
  }
  return terms;
}

/** Whisper's `prompt` is limited to roughly 224 tokens; this keeps the term list comfortably inside it. */
export function vocabularyPrompt(terms: readonly string[], maxChars = 600): string {
  let out = "";
  for (const term of terms) {
    const next = out ? `${out}, ${term}` : term;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}
