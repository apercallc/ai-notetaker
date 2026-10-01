/**
 * Notes templates for hosted processing. A template adds named sections to the
 * standard notes (overview, key points, decisions, action items) and a short
 * instruction that tells the model what matters for that kind of meeting.
 * Dependency-free so the picker (client) and the summarizer (server) agree.
 *
 * The ids are the existing meeting `mode` values; "custom" has no hosted
 * template and behaves like "general".
 */
export type NoteTemplateId = "general" | "standup" | "sales" | "one_on_one" | "interview" | "lecture" | "custom";

export interface NoteTemplateSection {
  heading: string;
  /** What belongs under the heading; shown to the model, never to the user. */
  hint: string;
}

export interface NoteTemplate {
  id: NoteTemplateId;
  label: string;
  description: string;
  sections: NoteTemplateSection[];
  /** Extra guidance appended to the summarizer's system prompt. */
  guidance: string;
}

export const NOTE_TEMPLATES: Record<NoteTemplateId, NoteTemplate> = {
  general: {
    id: "general",
    label: "General",
    description: "Overview, key points, decisions and action items.",
    sections: [],
    guidance: "",
  },
  standup: {
    id: "standup",
    label: "Standup",
    description: "Progress, plans and blockers, person by person.",
    sections: [
      { heading: "Progress", hint: "What each person says they finished or moved forward, naming the person." },
      { heading: "Plans", hint: "What each person says they will work on next, naming the person." },
      { heading: "Blockers", hint: "Anything blocking or slowing someone, and who could unblock it." },
    ],
    guidance: "This is a team standup. Keep bullets short and attribute each one to the person who said it.",
  },
  sales: {
    id: "sales",
    label: "Sales call",
    description: "Needs, objections, buying process and next steps.",
    sections: [
      { heading: "Customer needs", hint: "Problems, goals and requirements the prospect described." },
      { heading: "Objections and concerns", hint: "Hesitations, risks, competitors or pricing pushback raised." },
      { heading: "Budget, timeline and decision makers", hint: "Any stated budget, deadlines, approval steps or people involved." },
      { heading: "Next steps", hint: "Agreed follow-ups with owners and dates when stated." },
    ],
    guidance: "This is a sales or customer call. Distinguish what the customer said from what the seller said. Do not assume a deal stage that was not stated.",
  },
  one_on_one: {
    id: "one_on_one",
    label: "1:1",
    description: "Topics, feedback, support needed and commitments.",
    sections: [
      { heading: "Topics discussed", hint: "The subjects covered, in the order discussed." },
      { heading: "Feedback and recognition", hint: "Feedback given in either direction and wins that were called out." },
      { heading: "Concerns and support needed", hint: "Worries, obstacles or help one person asked of the other." },
      { heading: "Commitments", hint: "What each person agreed to do, naming the person." },
    ],
    guidance: "This is a private one-on-one conversation. Keep a respectful, factual tone and avoid characterising the people.",
  },
  interview: {
    id: "interview",
    label: "Interview",
    description: "Background, strengths, concerns and questions asked.",
    sections: [
      { heading: "Background", hint: "Role discussed and the candidate's stated experience." },
      { heading: "Strengths", hint: "Evidence of skills or accomplishments the candidate gave, in their own words." },
      { heading: "Concerns", hint: "Gaps or unclear answers, stated neutrally." },
      { heading: "Questions asked", hint: "The main questions the interviewer asked." },
      { heading: "Open questions", hint: "Topics worth following up on." },
    ],
    guidance: "This is a job interview. Report only what was said. Do not recommend hiring or rejecting, do not rate the candidate, and never infer or mention protected characteristics.",
  },
  lecture: {
    id: "lecture",
    label: "Lecture",
    description: "Key concepts, definitions, examples and review questions.",
    sections: [
      { heading: "Key concepts", hint: "The main ideas taught, each as one self-contained bullet." },
      { heading: "Definitions", hint: "Terms the speaker defined, as 'Term: meaning'." },
      { heading: "Examples", hint: "Worked examples, demonstrations or case studies mentioned." },
      { heading: "Questions to review", hint: "Questions a student could use to test their understanding, based only on what was taught." },
    ],
    guidance: "This is a lecture or talk. Capture the content accurately for later study. Decisions and action items are usually empty; leave them empty rather than inventing any.",
  },
  custom: {
    id: "custom",
    label: "Custom",
    description: "Treated like General for hosted notes.",
    sections: [],
    guidance: "",
  },
};

/** Templates a person can pick in the hosted UI ("custom" is accepted but not offered). */
export const PICKABLE_TEMPLATES: NoteTemplate[] = (["general", "standup", "sales", "one_on_one", "interview", "lecture"] as const).map((id) => NOTE_TEMPLATES[id]);

export function isNoteTemplateId(value: unknown): value is NoteTemplateId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NOTE_TEMPLATES, value);
}

/** Unknown or legacy values fall back to General so a stale mode can never break processing. */
export function noteTemplateFor(value: string | null | undefined): NoteTemplate {
  return isNoteTemplateId(value) ? NOTE_TEMPLATES[value] : NOTE_TEMPLATES.general;
}

/** Most times notes can be regenerated for one meeting; each run is a paid summary call. */
export const MAX_NOTES_REGENERATIONS = 3;
