import { breadcrumbNode, JsonLd, organizationNode, softwareNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { planPrices } from "@/marketing/Plans";
import { MarketingShell } from "@/marketing/Shell";
import { PricingView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "AI Notetaker pricing: free with your keys, sync from $12 a month";
const DESCRIPTION =
  "Free with your own AI keys. Cloud sync is Pro at $12 a month, and team sync is Team at $39 a month. Cancel any time.";

export const metadata = pageMetadata({ path: "/pricing", title: TITLE, description: DESCRIPTION });

export default async function PricingPage() {
  requireMarketing();
  const [context, prices] = [await marketingContext(), await planPrices()];
  const origin = siteOrigin();
  return (
    <MarketingShell current="/pricing" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/pricing", TITLE, DESCRIPTION),
          softwareNode(origin),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "Pricing", path: "/pricing" }]),
        ]}
      />
      <PricingView context={context} prices={prices} />
    </MarketingShell>
  );
}
