/**
 * Public marketing routes. They exist ONLY on the project-operated managed
 * deployment (MANAGED_HOSTING=true): they carry static product copy and never
 * read or render user data. Self-hosted instances keep the rule that every
 * route requires a session, so none of these paths are public there.
 */
export const MARKETING_PATHS = ["/", "/how-it-works", "/pricing", "/download", "/compare", "/privacy", "/terms"] as const;

export type MarketingPath = (typeof MARKETING_PATHS)[number];

const MARKETING_SET: ReadonlySet<string> = new Set(MARKETING_PATHS);

export function isMarketingPath(pathname: string): pathname is MarketingPath {
  return MARKETING_SET.has(pathname);
}

/** Request header the proxy sets so the root layout can drop the app chrome. */
export const MARKETING_HEADER = "x-marketing";
