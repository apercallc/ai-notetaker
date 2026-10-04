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
    "- Raw audio is saved on the device before any AI provider is called. Optional workspace sync uploads finished desktop note text and copies workspace notes into the desktop library. Web edits, deletions, and settings do not sync back, and extension recordings still need archive export/import.",
    "- Each meeting becomes a transcript, a summary, decisions and action items, searchable across meetings.",
    "- Ask your notes (Hosted Pro and Hosted Team only): questions answered from the user's own meetings, citing the notes used. Questions are not stored and do not use meeting hours.",
    `- Hosted AI also offers: importing an existing audio or video file (up to ${LIMITS.importHoursPro} hours on Pro, ${LIMITS.importHoursTeam} on Team, counted against monthly meeting hours); notes templates (General, Standup, Sales call, 1:1, Interview, Lecture) and per-meeting speaker renaming; a library with nested folders, editable text notes and a 30-day Trash; signed webhooks, Slack and Notion delivery; a read-only MCP server over the user's own notes using revocable tokens; ${LIMITS.languages} languages with spoken-language detection, custom vocabulary and translated summaries; and, on Team, an activity log for workspace owners.`,
    `- Open source under the ${SITE.license} license: ${SITE.repoUrl}`,
    "",
    "## Two ways to run the AI",
    "",
    `- Your own keys: free software. The user supplies AI provider keys and pays those providers directly. No AI Notetaker account is required.`,
    `- Hosted AI: the project runs transcription (Groq) and summaries (OpenAI). ${LIMITS.trial} free meetings with no card, then Hosted Pro at ${FALLBACK_PRICE_LABELS.hosted_pro} (up to ${LIMITS.pro} meetings or ${LIMITS.proHours} meeting hours and ${LIMITS.proQuestions} Ask-your-notes questions per month) or Hosted Team at ${FALLBACK_PRICE_LABELS.hosted_team} (shared workspace, up to ${LIMITS.team} meetings or ${LIMITS.teamHours} meeting hours and ${LIMITS.teamQuestions} Ask-your-notes questions per month). Billed monthly in USD through Stripe; cancel any time.`,
    "- Provider keys are configured in desktop Settings. Browser recording controls and archive export are configured in extension Settings. These settings are separate.",
    "",
    "## Data handling",
    "",
    "- Hosted AI uploads audio to private, temporary storage only for processing, deletes it when processing succeeds, and removes unfinished uploads within 24 hours. The hosted library stores text notes, not recordings.",
    "- Workspaces are isolated from each other. Provider credentials for Hosted AI stay on the server.",
    `- In own-keys mode, keys stay in protected storage on the user's device and the project receives no recordings, transcripts, notes or telemetry.`,
    `- Users are responsible for telling participants they are recording and obtaining any legally required consent.`,
    "",
    "## Pages",
    "",
    `- [Home](${page("/")}): overview and choosing a setup`,
    `- [How it works](${page("/how-it-works")}): step-by-step setup for Hosted AI and for your own keys`,
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
