import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { FAQS, SITE } from "@/marketing/content";
import { GET as getSummary } from "../llms.txt/route";

export const dynamic = "force-dynamic";

/**
 * Extended plain-text edition of /llms.txt for assistants that want the whole
 * story in one fetch: the summary plus every FAQ answer and canonical links.
 */
export async function GET(): Promise<Response> {
  if (!managedHostingEnabled()) return new Response("Not found", { status: 404 });
  const summary = await getSummary().text();
  const origin = getAppUrl();
  const body = [
    summary.trimEnd(),
    "",
    "## Canonical sources",
    "",
    `- Website: ${origin}`,
    `- Source code and issues: ${SITE.repoUrl}`,
    `- Latest release: ${SITE.releasesUrl}`,
    `- Questions answered above: ${FAQS.length}`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
