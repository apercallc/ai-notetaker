import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { FALLBACK_PRICE_LABELS, FAQS, LIMITS, SITE } from "@/marketing/content";

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
    `- Pro at ${FALLBACK_PRICE_LABELS.hosted_pro}: cloud sync of finished notes across the user's devices. Team at ${FALLBACK_PRICE_LABELS.hosted_team}: team sync with a shared workspace, activity log and retention controls. Cancel any time.`,
    "- Provider keys are configured in desktop Settings. Browser recording controls and archive export are configured in extension Settings. These settings are separate.",
    "",
    "## Data handling",
    "",
    "- The project never receives or stores recordings or provider keys. Only finished note text syncs, and only for subscribers who turn sync on.",
    "- Workspaces are isolated from each other.",
    `- In own-keys mode, keys stay in protected storage on the user's device and the project receives no recordings, transcripts, notes or telemetry.`,
    `- Users are responsible for telling participants they are recording and obtaining any legally required consent.`,
    "",
    "## Pages",
    "",
    `- [Home](${page("/")}): overview and choosing a setup`,
    `- [How it works](${page("/how-it-works")}): step-by-step setup with your own keys`,
    `- [Pricing](${page("/pricing")}): plans, limits and billing`,
    `- [Compare](${page("/compare")}): bot notetakers versus recording from your own device`,
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
