import type { LucideIcon } from "lucide-react";

/**
 * The single icon treatment for the marketing site: Lucide (ISC license),
 * 1.75 stroke, decorative by default. Every icon sits next to a text label,
 * so none carries meaning on its own.
 */
export function Icon({ as: Glyph, size = 20, label }: { as: LucideIcon; size?: number; label?: string }) {
  return (
    <Glyph
      className="mk-icon"
      size={size}
      strokeWidth={1.75}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
