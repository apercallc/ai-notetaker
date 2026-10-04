import { FALLBACK_PRICE_AMOUNTS, FAQS, LIMITS, SITE } from "./content";

type Node = Record<string, unknown>;

/** Serializes JSON-LD so a `<` in any string can never close the script element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</gu, "\\u003c");
}

export function JsonLd({ nodes }: { nodes: Node[] }) {
  const graph = { "@context": "https://schema.org", "@graph": nodes };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(graph) }} />;
}

const url = (origin: string, path = "/"): string => new URL(path, origin).toString();

export function organizationNode(origin: string): Node {
  return {
    "@type": "Organization",
    "@id": url(origin, "/#organization"),
    name: SITE.publisher,
    url: origin,
    logo: url(origin, "/ai-notetaker-mark.svg"),
    sameAs: [SITE.repoUrl],
  };
}

export function websiteNode(origin: string): Node {
  return {
    "@type": "WebSite",
    "@id": url(origin, "/#website"),
    url: origin,
    name: SITE.name,
    description: SITE.description,
    publisher: { "@id": url(origin, "/#organization") },
    inLanguage: "en",
  };
}

function monthlyOffer(origin: string, name: string, price: number, description: string): Node {
  return {
    "@type": "Offer",
    name,
    description,
    price: price.toFixed(2),
    priceCurrency: "USD",
    url: url(origin, "/pricing"),
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: price.toFixed(2),
      priceCurrency: "USD",
      billingDuration: "P1M",
      unitCode: "MON",
    },
  };
}

export function softwareNode(origin: string): Node {
  return {
    "@type": "SoftwareApplication",
    "@id": url(origin, "/#software"),
    name: SITE.name,
    url: origin,
    description: SITE.description,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Meeting notes",
    operatingSystem: "macOS, Windows, Linux",
    isAccessibleForFree: true,
    license: SITE.licenseUrl,
    codeRepository: SITE.repoUrl,
    downloadUrl: url(origin, "/download"),
    publisher: { "@id": url(origin, "/#organization") },
    featureList: [
      "One desktop app for setup, recording, and local meeting notes",
      "Captures browser and desktop meetings from microphone and system audio",
      "Saves audio on your device before any AI provider is called",
      "Keeps your microphone and the meeting's audio as separate channels",
      "Transcript, summary, decisions and action items for every meeting",
      "Local use with your own AI provider keys and no required account",
      "Optional workspace sync for finished note text",
      "Open source under the MIT license",
    ],
    offers: [
      {
        "@type": "Offer",
        name: "Own keys",
        description: "Free software. You bring your own AI provider keys and pay those providers directly.",
        price: "0.00",
        priceCurrency: "USD",
        url: url(origin, "/how-it-works"),
        availability: "https://schema.org/InStock",
      },
      monthlyOffer(origin, "Hosted Pro", FALLBACK_PRICE_AMOUNTS.hosted_pro, `Hosted AI for one person: up to ${LIMITS.pro} meetings or ${LIMITS.proHours} meeting hours a month, plus ${LIMITS.proQuestions} Ask-your-notes questions a month.`),
      monthlyOffer(origin, "Hosted Team", FALLBACK_PRICE_AMOUNTS.hosted_team, `Hosted AI for a shared workspace: up to ${LIMITS.team} meetings or ${LIMITS.teamHours} meeting hours a month, plus ${LIMITS.teamQuestions} Ask-your-notes questions a month.`),
    ],
  };
}

export function faqNode(origin: string): Node {
  return {
    "@type": "FAQPage",
    "@id": url(origin, "/#faq"),
    mainEntity: FAQS.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };
}

export function breadcrumbNode(origin: string, trail: { name: string; path: string }[]): Node {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: url(origin, item.path),
    })),
  };
}

export function howToNode(origin: string): Node {
  return {
    "@type": "HowTo",
    name: "How to take meeting notes without a meeting bot",
    description: "Install AI Notetaker, record from your own device, then review the transcript and action items.",
    url: url(origin, "/how-it-works"),
    step: [
      {
        "@type": "HowToStep",
        name: "Install",
        text: "Download one desktop app for setup, recording, and local notes. The download page shows currently available installers.",
      },
      {
        "@type": "HowToStep",
        name: "Record",
        text: "Acknowledge the recording notice, then start. Your microphone and the meeting's audio are saved on your device as two channels.",
      },
      {
        "@type": "HowToStep",
        name: "Review",
        text: "Open the transcript, summary, decisions and action items when the call ends, and search across your meetings.",
      },
    ],
  };
}

export function webPageNode(origin: string, path: string, name: string, description: string): Node {
  return {
    "@type": "WebPage",
    "@id": url(origin, path),
    url: url(origin, path),
    name,
    description,
    isPartOf: { "@id": url(origin, "/#website") },
    inLanguage: "en",
  };
}
