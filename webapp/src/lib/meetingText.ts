import { NOTE_TEMPLATES, isNoteTemplateId } from "./noteTemplates";

// Small display helpers shared by the owner's detail page, the public share
// page and the export buttons. Client-safe.

/** "one_on_one" → "One on one"; null for the default "general" mode, which says nothing. */
export function modeLabel(mode: string): string | null {
  if (!mode || mode === "general") return null;
  if (isNoteTemplateId(mode)) return NOTE_TEMPLATES[mode].label;
  const words = mode.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
