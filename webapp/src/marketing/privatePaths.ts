/**
 * Every top-level route that is not a public marketing page. robots.txt
 * disallows exactly these, and privatePaths.test.ts fails when a new route
 * appears under src/app without being classified here or in paths.ts, so a
 * private area can never be crawl-allowed by default.
 */
export const PRIVATE_PATHS = ["/api/", "/internal/", "/meetings", "/actions", "/account", "/billing", "/ask", "/import", "/trash", "/team", "/login", "/share/"] as const;

/** Top-level route folders under src/app and how each is treated. */
export const ROUTE_FOLDERS: Record<string, "private" | "marketing" | "metadata"> = {
  api: "private",
  internal: "private",
  meetings: "private",
  actions: "private",
  account: "private",
  billing: "private",
  ask: "private",
  import: "private",
  trash: "private",
  team: "private",
  login: "private",
  share: "private",
  "how-it-works": "marketing",
  pricing: "marketing",
  download: "marketing",
  compare: "marketing",
  alternatives: "marketing",
  privacy: "marketing",
  terms: "marketing",
  "llms.txt": "metadata",
  "llms-full.txt": "metadata",
};
