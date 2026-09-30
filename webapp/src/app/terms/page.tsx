import { breadcrumbNode, JsonLd, organizationNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { MarketingShell } from "@/marketing/Shell";
import { TermsView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "Terms of use | AI Notetaker";
const DESCRIPTION =
  "Terms for the AI Notetaker website, open-source software and Hosted AI service: recording consent, accounts, plans and billing, AI output, downloads and availability.";

export const metadata = pageMetadata({ path: "/terms", title: TITLE, description: DESCRIPTION });

export default async function TermsPage() {
  requireMarketing();
  const context = await marketingContext();
  const origin = siteOrigin();
  return (
    <MarketingShell current="/terms" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/terms", TITLE, DESCRIPTION),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "Terms", path: "/terms" }]),
        ]}
      />
      <TermsView />
    </MarketingShell>
  );
}
