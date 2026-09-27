/**
 * Escape values before inserting them into extension HTML templates.
 *
 * Quotes matter as much as angle brackets here: most call sites interpolate
 * into a double-quoted attribute (`value="${escapeHtml(x)}"`,
 * `aria-label="… ${escapeHtml(item.text)} …"`), and some of those values are
 * LLM output (summarized action-item text) rather than anything the user
 * typed. Escaping only `<`/`>`/`&` lets such a value close the attribute and
 * add arbitrary new ones to the same tag — `style="background:url(…)"` to
 * beacon the surrounding text out, `formaction`, `checked`, a `data-action-id`
 * pointing at a different row. MV3's `script-src 'self'` blocks inline event
 * handlers, but it does not make attribute injection harmless.
 *
 * Deliberately a pure string transform rather than the old
 * `div.textContent -> div.innerHTML` round-trip: that never escaped quotes at
 * all, and it only worked on a page with a DOM (never in the service worker).
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
