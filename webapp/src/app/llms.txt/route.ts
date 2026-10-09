import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { ALTERNATIVES } from "@/marketing/alternatives";
import { FAQS, LIMITS, SITE } from "@/marketing/content";

export const dynamic = "force-dynamic";

/**
 * Plain-text product facts for AI assistants and answer engines (llms.txt).
 * Generated from the same source as the pages and their structured data, so an
 * assistant is never told something the site does not say.
 */
export function GET(): Response {
  if (!managedHostingEnabled()) return new Response("Not found", { status: 404 });
  const origin = getAppUrl();
  const page = (path: string) => new URL(path, origin).toString();
  const body = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.tagline} ${SITE.description}`,
    "",
    "## What it is",
    "",
    "- A meeting notetaker that records from the user's own device, so no bot joins the call.",
    "- The Chrome extension captures the current browser tab and microphone separately for browser meetings such as Google Meet, Zoom, Microsoft Teams, Slack, and Discord. Export its archive and import it into the desktop app for transcription and note creation.",
    "- The AI Notetaker desktop app for macOS, Windows, and Linux captures browser and native desktop meetings, processes them locally, and stores notes on the device.",
    "- Raw audio is saved on the device before any AI provider is called. With a subscription, cloud sync uploads finished desktop note text and copies workspace notes into the desktop library. Web edits, deletions, and settings do not sync back, and extension recordings still need archive export/import.",
    "- Each meeting becomes a transcript, a summary, decisions and action items, searchable across meetings.",
    `- Open source under the ${SITE.license} license: ${SITE.repoUrl}`,
    "",
    "## Plans",
    "",
    `- Free: the desktop app with your own keys. The user supplies AI provider keys and pays those providers directly. No AI Notetaker account is required. A free account lets the user sign in and manage devices and data.`,
    "- Pro syncs one person's finished notes across devices. Team adds a shared workspace, activity log and retention controls. See the pricing page for current prices. Cancel any time.",
    "- Provider keys are configured in desktop Settings. Browser recording controls and archive export are configured in extension Settings. These settings are separate.",
    "",
    "## Facts",
    "",
    "- Platforms: macOS 13 or later (Apple silicon and Intel), Windows 10 or later (x64), Linux (Debian/Ubuntu .deb). Optional Chrome extension records browser meeting tabs.",
    "- AI providers (bring your own keys): Deepgram and Groq for transcription; Anthropic Claude, Google Gemini, Groq and DeepSeek for notes.",
    `- Transcription languages: ${LIMITS.languages}.`,
    `- License: ${SITE.license}. Source: ${SITE.repoUrl}. Latest installers: ${SITE.releasesUrl}`,
    `- Extended text for assistants: ${page("/llms-full.txt")}`,
    "",
    "## Data handling",
    "",
    "- Local BYOK saves raw audio on the device before sending it to the selected transcription provider; provider keys stay on the device. Optional note sync uploads finished note text only. Provider terms govern audio processing and retention.",
    "- Workspaces are isolated from each other.",
    `- In local BYOK mode, keys stay in protected storage on the user's device. The project service does not receive local-mode recordings, transcripts, notes or telemetry.`,
    `- Users are responsible for telling participants they are recording and obtaining any legally required consent.`,
    "",
    "## Pages",
    "",
    `- [Home](${page("/")}): overview and choosing a setup`,
    `- [How it works](${page("/how-it-works")}): step-by-step setup with your own keys`,
    `- [Pricing](${page("/pricing")}): plans, limits and billing`,
    `- [Compare](${page("/compare")}): bot notetakers versus recording from your own device`,
    ...ALTERNATIVES.map((alternative) => `- [${alternative.name} alternative](${page(`/alternatives/${alternative.slug}`)}): how AI Notetaker differs from ${alternative.name}`),
    `- [Download](${page("/download")}): Chrome extension and cross-platform desktop app`,
    `- [Privacy notice](${page("/privacy")}) and [Terms](${page("/terms")})`,
    `- [Source code](${SITE.repoUrl}), [releases](${SITE.releasesUrl}), [security policy](${SITE.securityUrl})`,
    "",
    "## Frequently asked questions",
    "",
    ...FAQS.flatMap((faq) => [`### ${faq.question}`, "", faq.answer, ""]),
  ].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
