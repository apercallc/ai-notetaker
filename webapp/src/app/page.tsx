import { redirect } from "next/navigation";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { Home } from "@/marketing/Home";
import { faqNode, howToNode, JsonLd, organizationNode, softwareNode, websiteNode, webPageNode } from "@/marketing/jsonld";
import { SITE } from "@/marketing/content";
import { marketingContext, pageMetadata, siteOrigin } from "@/marketing/page";
import { planPrices } from "@/marketing/Plans";
import { MarketingShell } from "@/marketing/Shell";

// Nonce-based CSP needs a per-request render, and the page reads the session.
export const dynamic = "force-dynamic";

const TITLE = "AI Notetaker: meeting notes without the meeting bot";

export const metadata = pageMetadata({ path: "/", title: TITLE, description: SITE.metaDescription });

export default async function RootPage() {
  // Self-hosted instances have no public front page: straight to the notes,
  // where the proxy has already required a session.
  if (!managedHostingEnabled()) redirect("/meetings");
  const [context, prices] = await Promise.all([marketingContext(), planPrices()]);
  if (context.signedIn) redirect("/meetings");
  const origin = siteOrigin();
  return (
    <MarketingShell current="/" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/", TITLE, SITE.metaDescription),
          softwareNode(origin, prices.structuredOffers),
          howToNode(origin),
          faqNode(origin),
        ]}
      />
      <Home context={context} prices={prices} />
    </MarketingShell>
  );
}
