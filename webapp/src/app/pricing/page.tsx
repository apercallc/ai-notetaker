import { breadcrumbNode, faqNode, JsonLd, organizationNode, softwareNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { planPrices } from "@/marketing/Plans";
import { MarketingShell } from "@/marketing/Shell";
import { PricingView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "AI Notetaker pricing: free with your keys, optional sync plans";
const DESCRIPTION =
  "Free with your own AI keys. Optional subscriptions add personal cloud sync or a shared Team workspace. See current prices and billing options.";

export const metadata = pageMetadata({ path: "/pricing", title: TITLE, description: DESCRIPTION });

export default async function PricingPage() {
  requireMarketing();
  const [context, prices] = await Promise.all([marketingContext(), planPrices()]);
  const origin = siteOrigin();
  return (
    <MarketingShell current="/pricing" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/pricing", TITLE, DESCRIPTION),
          softwareNode(origin, prices.structuredOffers),
          faqNode(origin, "pricing"),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "Pricing", path: "/pricing" }]),
        ]}
      />
      <PricingView context={context} prices={prices} />
    </MarketingShell>
  );
}
