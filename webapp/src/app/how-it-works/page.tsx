import { breadcrumbNode, faqNode, howToNode, JsonLd, organizationNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { MarketingShell } from "@/marketing/Shell";
import { HowItWorksView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

const TITLE = "How AI Notetaker works: record locally with your own keys";
const DESCRIPTION =
  "Set up AI Notetaker in a few minutes. Use your own AI keys, record Google Meet or desktop calls with no bot, and review transcripts and action items.";

export const metadata = pageMetadata({ path: "/how-it-works", title: TITLE, description: DESCRIPTION });

export default async function HowItWorksPage() {
  requireMarketing();
  const context = await marketingContext();
  const origin = siteOrigin();
  return (
    <MarketingShell current="/how-it-works" context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, "/how-it-works", TITLE, DESCRIPTION),
          howToNode(origin),
          faqNode(origin),
          breadcrumbNode(origin, [{ name: "AI Notetaker", path: "/" }, { name: "How it works", path: "/how-it-works" }]),
        ]}
      />
      <HowItWorksView context={context} />
    </MarketingShell>
  );
}
