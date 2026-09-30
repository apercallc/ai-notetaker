import { HOSTED_TRIAL_MEETINGS, PLAN_AUDIO_HOUR_LIMITS, PLAN_MEETING_LIMITS } from "@/lib/plans";

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
    answer: `Using your own AI keys is free (the providers you choose bill you directly). Hosted AI includes ${LIMITS.trial} free meetings with no card. After that, Pro is ${FALLBACK_PRICE_LABELS.hosted_pro} for up to ${n(LIMITS.pro)} meetings or ${n(LIMITS.proHours)} meeting hours a month, and Team is ${FALLBACK_PRICE_LABELS.hosted_team} for a shared workspace with up to ${n(LIMITS.team)} meetings or ${n(LIMITS.teamHours)} meeting hours a month. Cancel any time from the billing page.`,
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
      "Yes. You can delete any meeting, workspace owners can set how long hosted notes are kept, and you can export your data from your account page. Deleting a meeting from the hosted library removes its transcript and summary.",
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
