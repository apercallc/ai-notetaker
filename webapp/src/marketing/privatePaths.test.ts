import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETING_PATHS } from "./paths";
import { PRIVATE_PATHS, ROUTE_FOLDERS } from "./privatePaths";

const APP_DIR = path.resolve(__dirname, "../app");

/** Folders that define a URL: they contain a page or route handler somewhere below. */
function routeFolders(): string[] {
  const hasRoute = (dir: string): boolean =>
    readdirSync(dir).some((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return hasRoute(full);
      return /^(page|route)\.(t|j)sx?$/u.test(entry);
    });
  return readdirSync(APP_DIR).filter((entry) => {
    const full = path.join(APP_DIR, entry);
    return statSync(full).isDirectory() && hasRoute(full);
  });
}

describe("route classification", () => {
  it("classifies every top-level route folder as private, marketing or metadata", () => {
    const unclassified = routeFolders().filter((folder) => !(folder in ROUTE_FOLDERS));
    expect(unclassified, `classify these in marketing/privatePaths.ts (and paths.ts if public): ${unclassified.join(", ")}`).toEqual([]);
  });

  it("lists no folder that no longer exists", () => {
    const present = new Set(routeFolders());
    const stale = Object.keys(ROUTE_FOLDERS).filter((folder) => !present.has(folder));
    expect(stale).toEqual([]);
  });

  it("keeps robots' private list and the marketing allowlist consistent with the folders", () => {
    const privateFolders = Object.entries(ROUTE_FOLDERS).filter(([, kind]) => kind === "private").map(([folder]) => folder);
    for (const folder of privateFolders) {
      expect(PRIVATE_PATHS.some((entry) => entry === `/${folder}` || entry === `/${folder}/`), folder).toBe(true);
    }
    const marketingFolders = Object.entries(ROUTE_FOLDERS).filter(([, kind]) => kind === "marketing").map(([folder]) => `/${folder}`);
    expect([...marketingFolders].sort()).toEqual(MARKETING_PATHS.filter((entry) => entry !== "/").sort());
  });
});
