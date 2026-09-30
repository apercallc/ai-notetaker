import { breadcrumbNode, JsonLd, organizationNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { MarketingShell } from "@/marketing/Shell";
import { PrivacyView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "Privacy notice | AI Notetaker";
const DESCRIPTION =
  "What AI Notetaker collects, where your audio and notes go in local mode and in Hosted AI, which providers process data, and how to delete or export it.";

export const metadata = pageMetadata({ path: "/privacy", title: TITLE, description: DESCRIPTION });

export default async function PrivacyPage() {
  requireMarketing();
  const context = await marketingContext();
  const origin = siteOrigin();
  return (
    <MarketingShell current="/privacy" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/privacy", TITLE, DESCRIPTION),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "Privacy", path: "/privacy" }]),
        ]}
      />
      <PrivacyView />
    </MarketingShell>
  );
}
