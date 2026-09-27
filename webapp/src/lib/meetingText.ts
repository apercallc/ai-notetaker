// Small display helpers shared by the owner's detail page, the public share
// page and the export buttons. Client-safe.

/** "one_on_one" → "One on one"; null for the default "general" mode, which says nothing. */
export function modeLabel(mode: string): string | null {
  if (!mode || mode === "general") return null;
  const words = mode.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
