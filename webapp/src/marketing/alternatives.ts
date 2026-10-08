import { FALLBACK_PRICE_LABELS, SITE } from "./content";

/**
 * Comparison pages for the products people search for when they want a notetaker
 * that does not send a bot. Claims here are limited to structural facts that
 * hold across plans and versions (how the product joins a call, who hosts the
 * recording, licensing). Prices and plan limits change often, so the pages
 * point at each vendor's own pricing page instead of quoting numbers.
 */
export interface Alternative {
  slug: "otter" | "fireflies" | "granola" | "fathom";
  name: string;
  /** Vendor pricing page, linked so readers can check current terms themselves. */
  pricingUrl: string;
  /** Search-friendly page title and meta description. */
  title: string;
  description: string;
  lede: string;
  /** One honest sentence on what the other product is good at. */
  theirStrength: string;
  rows: { label: string; them: string; ours: string }[];
  /** Who should pick the other product. */
  whenTheyFit: string;
  /** Who should pick AI Notetaker. */
  whenWeFit: string;
}

/** Date the structural claims on every alternatives page were last checked. */
export const ALTERNATIVES_REVIEWED = "October 8, 2026";

const ours = {
  record: "Records on your own device from your microphone and the meeting audio. Nothing joins the call.",
  hosting: "The audio is saved on your device first. Only the providers you choose receive it, using your own keys.",
  ai: "Your own provider keys, billed to you by those providers directly.",
  price: `Free with your own keys. Optional cloud sync is Pro at ${FALLBACK_PRICE_LABELS.hosted_pro.replace(" / ", " a ")}; team sync is Team at ${FALLBACK_PRICE_LABELS.hosted_team.replace(" / ", " a ")}.`,
  source: `Open source under the ${SITE.license} license.`,
  platforms: "macOS, Windows and Linux desktop app, plus an optional Chrome extension for browser tabs.",
} as const;

export const ALTERNATIVES: Alternative[] = [
  {
    slug: "otter",
    name: "Otter.ai",
    pricingUrl: "https://otter.ai/pricing",
    title: "Otter.ai alternative with no meeting bot: AI Notetaker",
    description: "Looking for an Otter.ai alternative that does not add a bot to your calls? AI Notetaker records on your device, keeps audio local, and is free with your own AI keys.",
    lede: "Otter is a well-known cloud notetaker that can join your meetings as an extra participant. AI Notetaker records from your own device instead, and you keep the audio.",
    theirStrength: "Otter is mature and polished, with a large integration list and live transcription for teams that want a hosted service.",
    rows: [
      { label: "How it records", them: "A notetaker account can join scheduled meetings as a participant, or record in the app.", ours: ours.record },
      { label: "Where the recording lives", them: "In Otter's cloud service.", ours: ours.hosting },
      { label: "Who runs the AI", them: "Otter.", ours: ours.ai },
      { label: "Pricing model", them: "Per-seat subscription with monthly transcription limits on plans. See Otter's pricing page.", ours: ours.price },
      { label: "Source code", them: "Closed source.", ours: ours.source },
      { label: "Platforms", them: "Web, mobile and desktop apps.", ours: ours.platforms },
    ],
    whenTheyFit: "You want a hosted service that can join meetings you are not attending, with live captions and a large integration catalog, and you are happy for the vendor to hold the recording.",
    whenWeFit: "You are in the call, want nothing extra in it, want the audio to stay on your device, and would rather bring your own AI keys than pay a per-seat plan.",
  },
  {
    slug: "fireflies",
    name: "Fireflies.ai",
    pricingUrl: "https://fireflies.ai/pricing",
    title: "Fireflies.ai alternative without a bot in your meeting",
    description: "A Fireflies.ai alternative for people who do not want a notetaker bot in every call. AI Notetaker is open source, records locally, and works with your own AI keys.",
    lede: "Fireflies is built around a notetaker that joins your calls and a team workspace in the cloud. AI Notetaker keeps the recording on your device and the AI under your control.",
    theirStrength: "Fireflies is strong for sales and operations teams that want CRM integrations and automatic capture of every scheduled meeting.",
    rows: [
      { label: "How it records", them: "A notetaker bot joins scheduled meetings as a participant by default.", ours: ours.record },
      { label: "Where the recording lives", them: "In Fireflies' cloud service.", ours: ours.hosting },
      { label: "Who runs the AI", them: "Fireflies, with plan-based AI credits.", ours: ours.ai },
      { label: "Pricing model", them: "Per-seat tiers, billed monthly or yearly. See Fireflies' pricing page.", ours: ours.price },
      { label: "Source code", them: "Closed source.", ours: ours.source },
      { label: "Platforms", them: "Web app with calendar integrations and meeting-platform connectors.", ours: ours.platforms },
    ],
    whenTheyFit: "You need automatic capture of every scheduled call, including ones you skip, and deep CRM and workflow integrations for a team.",
    whenWeFit: "You join the call yourself, do not want a bot announcing itself to clients, and want to choose your own transcription and summary providers.",
  },
  {
    slug: "granola",
    name: "Granola",
    pricingUrl: "https://www.granola.ai/pricing",
    title: "Granola alternative that is open source and works on Linux",
    description: "A Granola alternative that is open source, bring-your-own-key, and runs on macOS, Windows and Linux. Botless meeting notes with the audio saved on your device.",
    lede: "Granola also skips the meeting bot by listening on your computer, and it is a good product. AI Notetaker takes the same botless approach and adds open source code, your own AI keys and a Linux app.",
    theirStrength: "Granola has a very clean note-taking experience that blends what you type with the transcript.",
    rows: [
      { label: "How it records", them: "Listens to your computer's audio. No bot joins.", ours: ours.record },
      { label: "Where the recording lives", them: "Notes are processed and stored through Granola's service.", ours: ours.hosting },
      { label: "Who runs the AI", them: "Granola.", ours: ours.ai },
      { label: "Pricing model", them: "Per-seat plans with a free tier. See Granola's pricing page.", ours: ours.price },
      { label: "Source code", them: "Closed source.", ours: ours.source },
      { label: "Platforms", them: "Check Granola's site for the current list of supported systems.", ours: ours.platforms },
    ],
    whenTheyFit: "You want a polished hosted notes app where the vendor runs the AI and you do not want to manage provider keys.",
    whenWeFit: "You want to inspect the code, choose and pay your AI providers directly, run on Linux as well as macOS and Windows, or keep the audio on your device.",
  },
  {
    slug: "fathom",
    name: "Fathom",
    pricingUrl: "https://fathom.video/pricing",
    title: "Fathom alternative with local recording and no bot",
    description: "A Fathom alternative that records on your device instead of sending a bot. AI Notetaker is free with your own AI keys and open source.",
    lede: "Fathom records your Zoom, Meet and Teams calls with a bot-based recorder and summarizes them in the cloud. AI Notetaker records locally and lets you pick the AI.",
    theirStrength: "Fathom is quick to set up and popular with individuals and sales teams who want call summaries and CRM updates with little effort.",
    rows: [
      { label: "How it records", them: "A recorder joins supported video calls.", ours: ours.record },
      { label: "Where the recording lives", them: "In Fathom's cloud service.", ours: ours.hosting },
      { label: "Who runs the AI", them: "Fathom.", ours: ours.ai },
      { label: "Pricing model", them: "Free tier with limits, then per-user plans. See Fathom's pricing page.", ours: ours.price },
      { label: "Source code", them: "Closed source.", ours: ours.source },
      { label: "Platforms", them: "Supported video-call platforms, via the service.", ours: ours.platforms },
    ],
    whenTheyFit: "You live in video calls and want the fastest path to summaries and CRM updates, and a vendor-hosted recording is fine.",
    whenWeFit: "You also take calls in apps other than the big video platforms, want separate microphone and meeting tracks, or want no third party holding your recordings.",
  },
];

export function alternativeBySlug(slug: string): Alternative | undefined {
  return ALTERNATIVES.find((alternative) => alternative.slug === slug);
}
