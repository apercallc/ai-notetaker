import { LANGUAGES } from "@/lib/languages";
import { HOSTED_TRIAL_MEETINGS, PLAN_AUDIO_HOUR_LIMITS, PLAN_CHAT_QUESTION_LIMITS, PLAN_IMPORT_MAX_SECONDS, PLAN_MEETING_LIMITS } from "@/lib/plans";

/**
 * One source of truth for every product fact the marketing site states: the
 * pages, the FAQ schema, and /llms.txt all read from here so people, search
 * engines, and AI assistants are always told the same thing.
 */
export const SITE = {
  name: "AI Notetaker",
  tagline: "Meeting notes without the meeting bot.",
  description:
    "One desktop app for macOS, Windows, and Linux records browser and desktop meetings, saves the audio on your device, and makes your notes with your own AI provider keys. An optional Chrome extension can record a browser tab. A free account lets you sign in and manage your devices; a subscription adds cloud sync and team sync. Raw audio and provider keys stay on the device.",
  /** ~155 characters: the snippet search results show. */
  metaDescription:
    "Botless AI meeting notes for Mac, Windows and Linux. Records on your device, free with your own AI keys. Optional cloud and team sync from $12/month.",
  repoUrl: "https://github.com/apercallc/ai-notetaker",
  releasesUrl: "https://github.com/apercallc/ai-notetaker/releases/latest",
  licenseUrl: "https://github.com/apercallc/ai-notetaker/blob/main/LICENSE",
  /** Name on the Stripe and Railway accounts; confirm the legal entity before launch. */
  publisher: "Aperca",
  supportUrl: "https://github.com/apercallc/ai-notetaker/issues",
  securityUrl: "https://github.com/apercallc/ai-notetaker/security/policy",
  license: "MIT",
} as const;

/**
 * Display prices used when Stripe cannot be reached (the pricing page reads the
 * live Stripe price first). Keep in step with the Stripe products.
 */
export const FALLBACK_PRICE_LABELS = { hosted_pro: "$12 / month", hosted_team: "$39 / month" } as const;
export const FALLBACK_PRICE_AMOUNTS = { hosted_pro: 12, hosted_team: 39 } as const;

export const LIMITS = {
  trial: HOSTED_TRIAL_MEETINGS,
  pro: PLAN_MEETING_LIMITS.hosted_pro,
  team: PLAN_MEETING_LIMITS.hosted_team,
  trialHours: PLAN_AUDIO_HOUR_LIMITS.hosted_trial,
  proHours: PLAN_AUDIO_HOUR_LIMITS.hosted_pro,
  teamHours: PLAN_AUDIO_HOUR_LIMITS.hosted_team,
  proQuestions: PLAN_CHAT_QUESTION_LIMITS.hosted_pro,
  teamQuestions: PLAN_CHAT_QUESTION_LIMITS.hosted_team,
  languages: LANGUAGES.length,
  importHoursPro: PLAN_IMPORT_MAX_SECONDS.hosted_pro / 3_600,
  importHoursTeam: PLAN_IMPORT_MAX_SECONDS.hosted_team / 3_600,
} as const;

const n = (value: number): string => value.toLocaleString("en-US");

export type FaqTopic = "setup" | "pricing";

export interface Faq {
  question: string;
  answer: string;
  /** Extra pages this question is relevant to (every question also appears on the home page). */
  topics?: FaqTopic[];
}

export const FAQS: Faq[] = [
  {
    question: "Does AI Notetaker join my meeting as a bot?",
    answer:
      "No. The desktop app captures browser or desktop audio from your device (the optional Chrome extension can record a browser tab). Nothing joins the participant list. You are still responsible for telling participants and following the recording-consent rules that apply to you.",
  },
  {
    question: "Do I need an account?",
    topics: ["setup", "pricing"],
    answer: `Nothing about recording or notes needs an account. The desktop app records on your device and makes your notes with your own transcription and summary API keys, so the app is free and works with no AI Notetaker login. A free account lets you sign in and manage your devices and data. A subscription adds cloud sync of finished notes across your devices and, with Team, shared workspaces. Your provider keys and raw audio never leave your device.`,
  },
  {
    question: "How much does AI Notetaker cost?",
    topics: ["pricing"],
    answer: `The desktop app is free with your own AI provider keys (the providers you choose bill you directly), and needs no account. A free account is also free. Cloud sync is a subscription: Pro is ${FALLBACK_PRICE_LABELS.hosted_pro} for one person, and Team is ${FALLBACK_PRICE_LABELS.hosted_team} for a shared workspace. Team adds shared libraries, an activity log and retention controls for workspace owners. Cancel any time from the billing page.`,
  },
  {
    question: "Will I lose my notes if I clear my browser history?",
    topics: ["setup"],
    answer:
      "Desktop recordings and notes are stored in the app's private data folder, not browser storage. Browser extension recordings stay in Chrome until exported and imported into the desktop app. With a subscription and sync turned on, finished desktop note text also appears in your web workspace.",
  },
  {
    question: "Can I send notes to Slack, Notion or Zapier, or use them with an AI assistant?",
    topics: ["pricing"],
    answer:
      "Yes. A workspace owner can set it up so that when a note is ready it is sent to a signed webhook (use it with Zapier, Make or n8n), a Slack channel or a Notion page. Webhook signing secrets and tokens are stored encrypted and shown only once. For AI assistants, you can create a read-only token in Settings and connect an assistant that supports the Model Context Protocol (MCP) to search and read your own notes; it cannot change or delete anything, and you can revoke the token at any time.",
  },
  {
    question: "Can I organise synced notes into folders and recover deleted ones?",
    topics: ["pricing"],
    answer:
      "Yes. The synced library has nested folders, plain text notes you can write or edit yourself, and upload of .md or .txt files. Search can be limited to a folder. Deleting a note or folder moves it to Trash, where you can restore it for 30 days before it is removed for good.",
  },
  {
    question: "Can I cancel any time?",
    topics: ["pricing"],
    answer:
      "Yes. Cancel from the billing page (Manage billing). Your plan stays active until the end of the period you already paid for and does not renew. Changed your mind before it ends? Resume it from the same page. Your recordings on your own device are never affected.",
  },
  {
    question: "Can I get a refund?",
    topics: ["pricing"],
    answer:
      "Yes, in these cases. New subscribers get a full refund of their first payment, monthly or yearly, if they ask within 14 days. A charge made by mistake or twice is refunded in full when you tell us within 60 days. If a yearly plan renews and you did not mean to keep it, ask within 7 days of the renewal for a full refund. If sync is unavailable because of us for more than 72 hours in a row, we refund the affected time. Outside those cases a period that has started is not refunded, but you keep your plan until it ends and it does not renew. Refunds go back to the original payment method and usually appear in 5 to 10 business days.",
  },
  {
    question: "What if I cancel a yearly plan partway through the year?",
    topics: ["pricing"],
    answer:
      "Your plan keeps working until the end of the year you paid for, and then it ends without renewing. We do not refund the unused months after the 14-day window, so cancel before a renewal if you do not want another year. If you want to switch to monthly, change your plan from Manage billing and the unused time on your yearly plan is credited toward the new price.",
  },
  {
    question: "Can I switch between Pro, Team, monthly and yearly?",
    topics: ["pricing"],
    answer:
      "Yes, from Manage billing on the billing page. The change takes effect straight away and the unused time on your current plan is credited toward the new price, so you are never charged twice for the same days. Moving to Team turns on the shared workspace features. Moving down to Pro keeps your notes but turns off the Team-only features.",
  },
  {
    question: "What happens if a Team owner cancels?",
    topics: ["pricing"],
    answer:
      "Only the workspace owner can cancel or change the plan. When the plan ends, sync stops for everyone in the workspace. Each member's notes stay in the workspace read-only and can be exported, and notes on each person's own computer are never affected. Anyone can subscribe again later and sync resumes.",
  },
  {
    question: "What if I think a charge is wrong?",
    topics: ["pricing"],
    answer:
      "Contact us first. We check it and refund anything charged in error, usually faster than a bank dispute. If you do open a dispute with your bank for a charge that was valid, we may pause sync on that workspace until it is resolved. Your notes stay available to read and export.",
  },
  {
    question: "What happens to my notes if I cancel or my payment fails?",
    topics: ["pricing"],
    answer:
      "Nothing is deleted, and notes on your computer are never touched. If a payment fails you keep full access for 3 days while it is retried, then sync stops until the payment goes through. After a plan ends, the notes already in your account stay there, read-only: you can still read, search, export and delete them, and download them to the desktop app. Editing, sharing, integrations, inviting people and uploading new notes need a plan. Notes you make on your computer in the meantime stay there and upload when you subscribe again. We do not delete notes because a plan ended.",
  },
  {
    question: "Do you store my card details?",
    topics: ["pricing"],
    answer: "No. Payments are handled by Stripe, which collects and holds your payment details. We only see your plan and its status.",
  },
  {
    question: "Where is my audio stored?",
    answer: `On your device, always. Raw audio is saved locally before anything is sent anywhere, and AI Notetaker never uploads your recordings. Only the text of finished notes syncs to the cloud, and only if you subscribe and turn sync on.`,
  },
  {
    question: "Which AI providers process my meetings?",
    answer: `Whichever you choose. Audio and text go only to the providers you select, using the keys you supply, under their terms. We never receive your keys or recordings.`,
  },
  {
    question: "Can I record browser meetings in Google Meet, Zoom, Teams, Slack or Discord?",
    topics: ["setup"],
    answer:
      "Yes. In Chrome, use the floating control on supported meeting sites, the toolbar popup, or the recording shortcut on the tab where the call audio is playing. Chrome may require a toolbar click or shortcut before the floating control can start capture. This works for web versions of Google Meet, Zoom, Microsoft Teams, Slack, Discord, and other meeting sites; exact behavior depends on the browser and site. For a meeting in a desktop app or another browser, use AI Notetaker for macOS, Windows, or Linux to capture system audio and your microphone. Cross-platform app and device checks are still in progress.",
  },
  {
    question: "When should I use the extension or desktop app?",
    topics: ["setup"],
    answer: "Use the desktop app: it records browser meetings in any browser and meetings in desktop apps, with no extension needed. The optional Chrome extension can also save a meeting tab's audio; export the archive and import it in the desktop app to transcribe and create notes. The desktop app stores and processes its recordings locally, and can optionally sync finished notes to a web-app workspace.",
  },
  {
    question: "Is AI Notetaker open source?",
    answer: `Yes. It is ${SITE.license} licensed and the source is on GitHub. You can read exactly what runs on your machine, and you can bring your own AI provider keys.`,
  },
  {
    question: "What happens if my browser or computer crashes mid-meeting?",
    answer:
      "Audio is written to your device as it is captured, so a crash does not lose what was already recorded. The desktop app checks for unfinished recordings on startup and offers recovery.",
  },
  {
    question: "Can I delete my meetings and data?",
    answer:
      "Yes. You can delete any meeting, workspace owners can set how long synced notes are kept, and you can export your data from your account page. Deleting a meeting or folder from the synced library moves it to Trash, where you can restore it for 30 days before it is removed for good; delete it from Trash to remove its transcript and summary immediately.",
  },
  {
    question: "Where can I read my notes?",
    topics: ["setup"],
    answer: "With a subscription, finished desktop notes sync to the cloud and appear in your selected workspace, and workspace notes are copied into the desktop library for local viewing. Web edits refresh workspace copies on the next sync; desktop-origin notes are protected from automatic overwrites. Deletions and settings do not sync back. Browser extension recordings remain in Chrome until you export and import them into the desktop app, so the extension does not yet share the live library.",
  },
];

export const NOT_LEGAL_ADVICE =
  "Always tell participants you are recording and get the consent that your local law and workplace policy require. AI Notetaker asks you to acknowledge this before every recording. It is not legal advice.";

/**
 * A monitored support address, set as SUPPORT_EMAIL on the deployment. It is
 * optional and validated, and never hard-coded, so the legal pages only show an
 * address the operator has actually chosen to publish.
 */
/**
 * The jurisdiction whose law governs the terms, e.g. "the State of Texas".
 * Operator-supplied because it depends on where the publisher is organized;
 * when unset the clause is omitted rather than guessed.
 */
export function governingLaw(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.GOVERNING_LAW?.trim();
  return value && value.length <= 120 && /^[\p{L}\p{N} ,.'()-]+$/u.test(value) ? value : null;
}

export function supportEmail(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SUPPORT_EMAIL?.trim();
  return value && value.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/u.test(value) ? value : null;
}
