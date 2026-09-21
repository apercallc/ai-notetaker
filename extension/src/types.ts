/**
 * Types mirroring docs/native-messaging-protocol.md and docs/webapp-api.md.
 * Keep these in sync with those docs — they are the contract, not this file.
 */

export type TranscriptionProvider = "deepgram" | "groq";
export type SummarizationProvider = "claude" | "gemini" | "deepseek";
export type ProviderKind = TranscriptionProvider | SummarizationProvider;
export type MeetingMode = "general" | "standup" | "sales" | "one_on_one" | "interview" | "custom";
export type ActionItemStatus = "open" | "done";

export interface ProviderApiKeys {
  deepgram?: string;
  claude?: string;
  groq?: string;
  gemini?: string;
  deepseek?: string;
}

export interface WebappConfig {
  url: string;
  token: string;
}

export interface AudioStatus {
  platform: string;
  driver: string;
  driverInstalled: boolean;
  microphone: string | null;
  speaker: string | null;
  ready: boolean;
  guidance: string;
}

export interface AudioProbeResult {
  micFrames: number;
  speakerFrames: number;
  passed: boolean;
  message: string;
}

export interface NotetakerSettings {
  transcriptionProvider: TranscriptionProvider;
  summarizationProvider: SummarizationProvider;
  apiKeys: ProviderApiKeys;
  webapp: WebappConfig | null;
  defaultMeetingMode: MeetingMode;
  customVocabulary: string[];
  customSummaryInstructions: string;
  onboardingComplete: boolean;
  consentDisclosureAcknowledged: boolean;
}

export const DEFAULT_SETTINGS: NotetakerSettings = {
  transcriptionProvider: "deepgram",
  summarizationProvider: "claude",
  apiKeys: {},
  webapp: null,
  defaultMeetingMode: "general",
  customVocabulary: [],
  customSummaryInstructions: "",
  onboardingComplete: false,
  consentDisclosureAcknowledged: false,
};

export type Speaker = "you" | `them${"" | `-${number}`}`;

/**
 * Renders a wire-level speaker id into a display label. The data model
 * (and the helper's diarization, see helper/crates/core/src/providers/deepgram.rs)
 * distinguishes multiple non-"you" speakers ("them", "them-2", "them-3", ...)
 * — collapsing them all into one "Them" label throws away real information
 * the transcript is meant to carry (found in design review, see TODO.md).
 */
export function speakerLabel(speaker: Speaker): string {
  if (speaker === "you") return "You";
  const match = /^them-(\d+)$/.exec(speaker);
  return match ? `Them ${match[1]}` : "Them";
}

export interface TranscriptSegment {
  speaker: Speaker;
  text: string;
  timestamp: string;
  isFinal: boolean;
}

export interface ActionItem {
  id?: string;
  text: string;
  owner?: string;
  status?: ActionItemStatus;
  dueAt?: string | null;
  completedAt?: string | null;
}

export interface MeetingRecord {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  transcript: TranscriptSegment[];
  summary: string | null;
  actionItems: ActionItem[];
  mode?: MeetingMode;
  status: "recording" | "processing" | "complete" | "error";
  errorMessage?: string;
}

// ---- Native Messaging: extension -> helper ----

export type OutgoingMessage =
  | { type: "hello"; pairingToken: string | null }
  | {
      type: "settings";
      transcriptionProvider: TranscriptionProvider;
      summarizationProvider: SummarizationProvider;
      apiKeys: ProviderApiKeys;
      webapp: WebappConfig | null;
      defaultMeetingMode: MeetingMode;
      customVocabulary: string[];
      customSummaryInstructions: string;
    }
  | { type: "start_recording"; meetingId: string; meetingMode: MeetingMode }
  | { type: "stop_recording"; meetingId: string }
  | { type: "resume_recording"; meetingId: string }
  | { type: "discard_recording"; meetingId: string }
  | { type: "test_provider_key"; provider: ProviderKind; key: string }
  | { type: "audio_preflight" }
  | { type: "audio_probe" };

// ---- Native Messaging: helper -> extension ----

export type IncomingMessage =
  | { type: "paired"; pairingToken: string }
  | { type: "recording_started"; meetingId: string }
  | { type: "recording_stopped"; meetingId: string }
  | {
      type: "transcript_partial";
      meetingId: string;
      speaker: Speaker;
      text: string;
      isFinal: boolean;
    }
  | {
      type: "summary_ready";
      meetingId: string;
      summary: string;
      actionItems: ActionItem[];
    }
  | { type: "error"; meetingId: string | null; code: string; message: string }
  | { type: "recovered_recording"; meetingId: string; startedAt: string }
  | { type: "provider_key_test_result"; provider: ProviderKind; valid: boolean; message: string }
  | {
      type: "audio_status";
      platform: string;
      driver: string;
      driverInstalled: boolean;
      microphone: string | null;
      speaker: string | null;
      ready: boolean;
      guidance: string;
    }
  | { type: "audio_probe_result"; micFrames: number; speakerFrames: number; passed: boolean; message: string };

export function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const validTypes: IncomingMessage["type"][] = [
    "paired",
    "recording_started",
    "recording_stopped",
    "transcript_partial",
    "summary_ready",
    "error",
    "recovered_recording",
    "provider_key_test_result",
    "audio_status",
    "audio_probe_result",
  ];
  return validTypes.includes((value as { type: string }).type as IncomingMessage["type"]);
}
