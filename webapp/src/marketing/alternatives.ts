import { SITE } from "./content";

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
  hosting: "Raw audio is saved on your device first. In local BYOK mode, the selected transcription provider receives it; note sync uploads finished text only.",
  ai: "Your own provider keys, billed to you by those providers directly.",
  price: "Free with your own keys. Optional personal and team sync; see the pricing page for current prices.",
  source: `Open source under the ${SITE.license} license.`,
  platforms: "macOS, Windows and Linux desktop app, plus an optional Chrome extension for browser tabs.",
} as const;

export const ALTERNATIVES: Alternative[] = [
  {
    slug: "otter",
    name: "Otter.ai",
    pricingUrl: "https://otter.ai/pricing",
    title: "Open source Otter.ai alternative with your own AI keys",
    description: "Looking for an open source Otter.ai alternative that lets you choose your AI providers? AI Notetaker saves audio locally before sending it to your chosen transcription provider.",
    lede: "Otter supports both meeting-assistant and botless desktop recording. AI Notetaker differs with open source code and provider keys you choose and keep on your device.",
    theirStrength: "Otter is mature and polished, with a large integration list and live transcription for teams that want a hosted service.",
    rows: [
      { label: "How it records", them: "A bot can join scheduled meetings; Otter also supports botless desktop recording.", ours: ours.record },
      { label: "Where the recording lives", them: "In Otter's cloud service.", ours: ours.hosting },
      { label: "Who runs the AI", them: "Otter.", ours: ours.ai },
      { label: "Pricing model", them: "Per-seat subscription with monthly transcription limits on plans. See Otter's pricing page.", ours: ours.price },
      { label: "Source code", them: "Closed source.", ours: ours.source },
      { label: "Platforms", them: "Web, mobile and desktop apps.", ours: ours.platforms },
    ],
    whenTheyFit: "You want live captions and a hosted notes library, with the option of a meeting bot or botless desktop recording.",
    whenWeFit: "You are in the call, want nothing extra in it, want audio saved locally before transcription, and prefer your own AI keys. The provider you select still receives audio for transcription.",
  },
  {
    slug: "fireflies",
    name: "Fireflies.ai",
    pricingUrl: "https://fireflies.ai/pricing",
    title: "Open source Fireflies.ai alternative with your own AI keys",
    description: "An open source Fireflies.ai alternative that lets you choose your transcription and summary providers. Audio is saved locally before transcription.",
    lede: "Fireflies offers automatic meeting capture and a Chrome extension that can record Google Meet without its bot. AI Notetaker differs with open source code and provider keys you choose.",
    theirStrength: "Fireflies is strong for sales and operations teams that want CRM integrations and automatic capture of every scheduled meeting.",
    rows: [
      { label: "How it records", them: "A bot can autojoin scheduled calls; its Chrome extension also supports botless recording for Google Meet.", ours: ours.record },
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
    description: "A Granola alternative that is open source, bring-your-own-key, and runs on macOS, Windows and Linux. Botless meeting notes with audio saved locally before provider transcription.",
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
    whenWeFit: "You want to inspect the code, choose and pay your AI providers directly, and run on Linux as well as macOS and Windows. Audio is saved locally before your provider transcribes it.",
  },
  {
    slug: "fathom",
    name: "Fathom",
    pricingUrl: "https://fathom.video/pricing",
    title: "Open source Fathom alternative with your own AI keys",
    description: "An open source Fathom alternative that lets you choose your transcription and summary providers. Audio is saved locally before provider transcription.",
    lede: "Fathom offers bot and bot-free capture options. AI Notetaker differs with open source code, your choice of AI providers, and support for Linux.",
    theirStrength: "Fathom is quick to set up and popular with individuals and sales teams who want call summaries and CRM updates with little effort.",
    rows: [
      { label: "How it records", them: "Bot and bot-free capture options are available, depending on platform and mode.", ours: ours.record },
      { label: "Where the recording lives", them: "In Fathom's cloud service.", ours: ours.hosting },
      { label: "Who runs the AI", them: "Fathom.", ours: ours.ai },
      { label: "Pricing model", them: "Free tier with limits, then per-user plans. See Fathom's pricing page.", ours: ours.price },
      { label: "Source code", them: "Closed source.", ours: ours.source },
      { label: "Platforms", them: "Supported video-call platforms, via the service.", ours: ours.platforms },
    ],
    whenTheyFit: "You live in video calls and want the fastest path to summaries and CRM updates, and a vendor-hosted recording is fine.",
    whenWeFit: "You take calls in apps beyond the major video platforms, want separate microphone and meeting tracks, and want to choose which provider receives the audio.",
  },
];

export function alternativeBySlug(slug: string): Alternative | undefined {
  return ALTERNATIVES.find((alternative) => alternative.slug === slug);
}
