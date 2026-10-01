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
    "AI Notetaker records Google Meet in Chrome and desktop calls (Zoom, Teams, Slack) from your own device, so no bot joins the call. It turns each meeting into a transcript, summary, decisions and action items. Use it free with your own AI keys, or let us run the AI for a flat monthly price.",
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
      "No. Google Meet is captured by the Chrome extension from your own browser tab and microphone. Zoom, Microsoft Teams, Slack huddles and other desktop calls are captured by a small native helper that records your microphone and system audio. Nothing is added to the participant list. You are still responsible for telling participants and following the recording-consent rules that apply to you.",
  },
  {
    question: "What is the difference between Hosted AI and using my own keys?",
    topics: ["setup", "pricing"],
    answer:
      "With Hosted AI we run the transcription and summaries for you and you pay one flat monthly price. With your own keys the software is free: you create accounts with the AI providers you prefer, paste in their keys, and pay those providers directly. No AI Notetaker account is needed. Recordings are saved on your device first in both modes, and you can switch in the extension's Settings at any time.",
  },
  {
    question: "How much does AI Notetaker cost?",
    topics: ["pricing"],
    answer: `Using your own AI keys is free (the providers you choose bill you directly). Hosted AI includes ${LIMITS.trial} free meetings with no card. After that, Pro is ${FALLBACK_PRICE_LABELS.hosted_pro} for up to ${n(LIMITS.pro)} meetings or ${n(LIMITS.proHours)} meeting hours a month, and Team is ${FALLBACK_PRICE_LABELS.hosted_team} for a shared workspace with up to ${n(LIMITS.team)} meetings or ${n(LIMITS.teamHours)} meeting hours a month. Both include Ask your notes (${n(LIMITS.proQuestions)} and ${n(LIMITS.teamQuestions)} questions a month), file import, notes templates, the library, integrations and the MCP connection; Team adds an activity log for workspace owners. Imported recordings use the same monthly meeting hours as live meetings. Cancel any time from the billing page.`,
  },
  {
    question: "Can I ask questions about my past meetings?",
    topics: ["pricing"],
    answer: `Yes. Ask your notes is included with Hosted Pro (${n(LIMITS.proQuestions)} questions a month) and Hosted Team (${n(LIMITS.teamQuestions)} a month); the free trial and bring-your-own-keys mode do not include it. Answers come only from your own meeting notes and link to the notes they used. Questions do not use up meeting hours, the allowance resets each billing period, and your questions and answers are not stored.`,
  },
  {
    question: "Will I lose my notes if I clear my browser history?",
    topics: ["setup"],
    answer:
      "No. Clearing history, cookies or cache does not delete notes. With Hosted AI your notes are stored in your workspace, so only a sign-in is needed again. In local mode they are stored in the extension on your device: they stay unless you uninstall the extension, delete the Chrome profile, or lose the device, and we hold no copy. Sync to Hosted AI or your own history server, or export the notes you want to keep.",
  },
  {
    question: "Can I import a recording I already have?",
    topics: ["pricing"],
    answer: `Yes, with Hosted AI. Open Import in the web app and choose an audio or video file (mp3, m4a, wav, mp4, mov, mkv and more, up to 1.9 GB). It is transcribed and summarized like a live meeting. A single file can run up to ${LIMITS.importHoursPro} hours on Pro and ${LIMITS.importHoursTeam} hours on Team, and its length counts against your monthly meeting hours. The file is deleted once it has been processed. Imported files have no separate microphone channel, so speakers appear as Speaker 1, Speaker 2 and so on when the provider can tell them apart; you can rename them afterwards. Importing in the free own-keys mode is not available yet.`,
  },
  {
    question: "Can I choose the format of my notes and rename the speakers?",
    topics: ["pricing"],
    answer:
      "Yes, with Hosted AI. Pick a template per meeting: General, Standup, Sales call, 1:1, Interview or Lecture, and rewrite a meeting's notes with a different template later (up to three times per meeting; your action items are kept and the earlier text can be restored). Click a speaker's name in the transcript to rename them once; the new name replaces the old one throughout the transcript, summary, action-item owners, exports, shares and Ask your notes.",
  },
  {
    question: "Which languages are supported?",
    topics: ["pricing"],
    answer: `With Hosted AI you can set a spoken-language hint or let the transcriber detect the language, write the notes in a different language than the one spoken (for example, a translated summary), and add custom vocabulary so names and jargon are spelled correctly. ${LIMITS.languages} languages are offered for hints and summaries. Accuracy depends on the transcription provider and the audio.`,
  },
  {
    question: "Can I send notes to Slack, Notion or Zapier, or use them with an AI assistant?",
    topics: ["pricing"],
    answer:
      "Yes. A workspace owner can set it up so that when a note is ready it is sent to to a signed webhook (use it with Zapier, Make or n8n), a Slack channel or a Notion page. Webhook signing secrets and tokens are stored encrypted and shown only once. For AI assistants, you can create a read-only token in Settings and connect an assistant that supports the Model Context Protocol (MCP) to search and read your own notes; it cannot change or delete anything, and you can revoke the token at any time.",
  },
  {
    question: "Can I organise notes into folders and recover deleted ones?",
    topics: ["pricing"],
    answer:
      "Yes. The hosted library has nested folders, plain text notes you can write or edit yourself, and upload of .md or .txt files. Search and Ask your notes can be limited to a folder. Deleting a note or folder moves it to Trash, where you can restore it for 30 days before it is removed for good.",
  },
  {
    question: "Can I cancel any time?",
    topics: ["pricing"],
    answer:
      "Yes. Cancel from the billing page. Your plan stays active until the end of the period you already paid for, and your recordings on your own device are never affected.",
  },
  {
    question: "Do you store my card details?",
    topics: ["pricing"],
    answer: "No. Payments are handled by Stripe, which collects and holds your payment details. We only see your plan and its status.",
  },
  {
    question: "Where is my audio stored?",
    answer:
      "On your device first, before anything is sent anywhere. With Hosted AI the audio is uploaded to a private, temporary staging area only so it can be transcribed, and it is deleted as soon as processing succeeds. Uploads that never finish are removed within 24 hours. The hosted library keeps your text notes, not your recordings.",
  },
  {
    question: "Which AI providers process my meetings in Hosted AI?",
    answer:
      "Transcription runs on Groq and summaries run on OpenAI. Both receive only what is needed to process your meeting. In free own-keys mode, audio and text go only to the providers you select, using the keys you supply.",
  },
  {
    question: "Does it work with Zoom, Microsoft Teams and Slack?",
    topics: ["setup"],
    answer:
      "Through the desktop helper for macOS, Windows or Linux, which captures your microphone and the meeting's system audio as two separate channels so \"you\" and \"everyone else\" stay distinct. The helper's audio check confirms your setup before you record. We are still verifying every app on every operating system, so please tell us if something does not work. Google Meet does not need the helper.",
  },
  {
    question: "Do I need the desktop helper for Google Meet?",
    topics: ["setup"],
    answer: "No. The Chrome extension records Google Meet by itself. Add the helper only if you also meet in other desktop apps.",
  },
  {
    question: "Is AI Notetaker open source?",
    answer: `Yes. It is ${SITE.license} licensed and the source is on GitHub. You can read exactly what runs on your machine, and you can self-host the optional meeting-history app.`,
  },
  {
    question: "What happens if my browser or computer crashes mid-meeting?",
    answer:
      "Audio is written to your device as it is captured, so a crash does not lose what was already recorded. The helper checks for an unfinished recording on startup and offers to resume it, and the extension restores an active Google Meet recording after a browser restart.",
  },
  {
    question: "Can I delete my meetings and data?",
    answer:
      "Yes. You can delete any meeting, workspace owners can set how long hosted notes are kept, and you can export your data from your account page. Deleting a meeting or folder from the hosted library moves it to Trash, where you can restore it for 30 days before it is removed for good; delete it from Trash to remove its transcript and summary immediately.",
  },
  {
    question: "Which browsers are supported?",
    topics: ["setup"],
    answer: "Google Chrome for the extension today. The desktop helper works with any meeting app on macOS, Windows and Linux.",
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
