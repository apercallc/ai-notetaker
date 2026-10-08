import { notFound } from "next/navigation";
import { ALTERNATIVES, alternativeBySlug } from "@/marketing/alternatives";
import { breadcrumbNode, JsonLd, organizationNode, webPageNode, websiteNode } from "@/marketing/jsonld";
import { marketingContext, pageMetadata, requireMarketing, siteOrigin } from "@/marketing/page";
import { MarketingShell } from "@/marketing/Shell";
import { AlternativeView } from "@/marketing/Views";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams(): { slug: string }[] {
  return ALTERNATIVES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Params) {
  const alternative = alternativeBySlug((await params).slug);
  if (!alternative) return {};
  return pageMetadata({ path: `/alternatives/${alternative.slug}`, title: alternative.title, description: alternative.description });
}

export default async function AlternativePage({ params }: Params) {
  requireMarketing();
  const alternative = alternativeBySlug((await params).slug);
  if (!alternative) notFound();
  const context = await marketingContext();
  const origin = siteOrigin();
  const path = `/alternatives/${alternative.slug}` as const;
  return (
    <MarketingShell current={path} context={context}>
      <JsonLd
        nodes={[
          organizationNode(origin),
          websiteNode(origin),
          webPageNode(origin, path, alternative.title, alternative.description),
          breadcrumbNode(origin, [
            { name: "AI Notetaker", path: "/" },
            { name: "Compare", path: "/compare" },
            { name: `${alternative.name} alternative`, path },
          ]),
        ]}
      />
      <AlternativeView alternative={alternative} context={context} />
    </MarketingShell>
  );
}
