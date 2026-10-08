import { FALLBACK_PRICE_AMOUNTS, FAQS, LIMITS, SITE, type FaqTopic } from "./content";

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
      "Chrome extension captures audio from browser meeting tabs, including Google Meet, Zoom, Teams, Slack, and Discord web",
      "Desktop app captures browser and desktop meetings on macOS, Windows, and Linux",
      "Saves audio on your device before any AI provider is called",
      "Keeps your microphone and the meeting's audio as separate channels",
      "Transcript, summary, decisions and action items for every meeting",
      "Local use with your own AI provider keys and no required account",
      "A subscription adds cloud sync of finished desktop note text and imports workspace notes into the desktop library",
      "Open source under the MIT license",
    ],
    offers: [
      {
        "@type": "Offer",
        name: "Free",
        description: "Free software. You bring your own AI provider keys and pay those providers directly.",
        price: "0.00",
        priceCurrency: "USD",
        url: url(origin, "/how-it-works"),
        availability: "https://schema.org/InStock",
      },
      monthlyOffer(origin, "Pro", FALLBACK_PRICE_AMOUNTS.hosted_pro, "Cloud sync of notes across your devices for one person."),
      monthlyOffer(origin, "Team", FALLBACK_PRICE_AMOUNTS.hosted_team, "Team sync: a shared workspace and library for your teammates."),
    ],
  };
}

/** Mirrors the visible `<Faq topic>` list so the markup never claims answers the page does not show. */
export function faqNode(origin: string, topic?: FaqTopic): Node {
  const items = topic ? FAQS.filter((faq) => faq.topics?.includes(topic)) : FAQS;
  return {
    "@type": "FAQPage",
    "@id": url(origin, topic ? `/#faq-${topic}` : "/#faq"),
    mainEntity: items.map((faq) => ({
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
        text: "Choose the Chrome extension to capture a browser meeting tab, or download the desktop app for browser and desktop capture, processing, and local notes. The download page shows currently available installers.",
      },
      {
        "@type": "HowToStep",
        name: "Record",
        text: "Acknowledge the recording notice, then start. The Chrome extension saves tab and microphone audio for later import, while the desktop app can record and process browser or desktop calls locally.",
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
