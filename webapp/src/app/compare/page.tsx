import { breadcrumbNode, JsonLd, organizationNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { MarketingShell } from "@/marketing/Shell";
import { CompareView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "Bot notetaker vs botless AI Notetaker: what changes";
const DESCRIPTION =
  "Compare bot notetakers that join your call with AI Notetaker, which records from your own device. See the differences in privacy, audio, desktop apps, pricing and source code.";

export const metadata = pageMetadata({ path: "/compare", title: TITLE, description: DESCRIPTION });

export default async function ComparePage() {
  requireMarketing();
  const context = await marketingContext();
  const origin = siteOrigin();
  return (
    <MarketingShell current="/compare" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/compare", TITLE, DESCRIPTION),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "Compare", path: "/compare" }]),
        ]}
      />
      <CompareView context={context} />
    </MarketingShell>
  );
}
