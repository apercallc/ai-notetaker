import type { MetadataRoute } from "next";
import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { PRIVATE_PATHS } from "@/marketing/privatePaths";

export const dynamic = "force-dynamic";

/** Everything behind a login, plus expiring share links, stays out of every index. */
const PRIVATE = [...PRIVATE_PATHS];

/**
 * Search and answer-engine crawlers are welcome on the public product pages.
 * Named explicitly so the intent is unambiguous to each operator.
 */
const AI_AND_SEARCH_CRAWLERS = [
  "Googlebot",
  "Bingbot",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "DuckDuckBot",
  "CCBot",
  "Amazonbot",
  "Meta-ExternalAgent",
  "cohere-ai",
];

export default function robots(): MetadataRoute.Robots {
  // A self-hosted instance is private: nothing on it should ever be crawled.
  if (!managedHostingEnabled()) return { rules: [{ userAgent: "*", disallow: "/" }] };
  const origin = getAppUrl();
  return {
    rules: [
      { userAgent: AI_AND_SEARCH_CRAWLERS, allow: "/", disallow: PRIVATE },
      { userAgent: "*", allow: "/", disallow: PRIVATE },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
