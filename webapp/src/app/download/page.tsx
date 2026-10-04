import { breadcrumbNode, JsonLd, organizationNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { latestRelease } from "@/marketing/release";
import { MarketingShell } from "@/marketing/Shell";
import { DownloadView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "Download AI Notetaker";
const DESCRIPTION =
  "Download the AI Notetaker desktop app for setup, local meeting capture, and notes. Local use needs no browser extension or AI Notetaker account.";

export const metadata = pageMetadata({ path: "/download", title: TITLE, description: DESCRIPTION });

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export default async function DownloadPage({ searchParams }: { searchParams: SearchParams }) {
  requireMarketing();
  // Preserve old query parameters without steering desktop users into the
  // legacy extension/helper setup.
  const query = await searchParams;
  const platformHint = first(query.platform);
  const platform = platformHint === "macos" || platformHint === "windows" || platformHint === "linux" ? platformHint : undefined;
  const [context, release] = [await marketingContext(), await latestRelease()];
  const origin = siteOrigin();
  return (
    <MarketingShell current="/download" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/download", TITLE, DESCRIPTION),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "Download", path: "/download" }]),
        ]}
      />
      <DownloadView release={release} platform={platform} />
    </MarketingShell>
  );
}
