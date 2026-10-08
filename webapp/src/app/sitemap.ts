import type { MetadataRoute } from "next";
import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { MARKETING_PATHS, type MarketingPath } from "@/marketing/paths";

export const dynamic = "force-dynamic";

// Bump when a page's content meaningfully changes; a fake "always now" date teaches crawlers to ignore it.
const CONTENT_UPDATED = new Date("2026-10-08T00:00:00Z");

const PRIORITY: Record<MarketingPath, number> = {
  "/": 1,
  "/pricing": 0.9,
  "/how-it-works": 0.8,
  "/download": 0.8,
  "/compare": 0.7,
  "/alternatives/otter": 0.7,
  "/alternatives/fireflies": 0.7,
  "/alternatives/granola": 0.7,
  "/alternatives/fathom": 0.7,
  "/privacy": 0.3,
  "/terms": 0.3,
};

export default function sitemap(): MetadataRoute.Sitemap {
  if (!managedHostingEnabled()) return [];
  const origin = getAppUrl();
  return MARKETING_PATHS.map((path) => ({
    url: new URL(path, origin).toString(),
    lastModified: CONTENT_UPDATED,
    changeFrequency: path === "/privacy" || path === "/terms" ? "yearly" : "monthly",
    priority: PRIORITY[path],
  }));
}
