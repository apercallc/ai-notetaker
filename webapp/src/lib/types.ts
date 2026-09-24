// Shapes match docs/webapp-api.md exactly — that file is the contract with
// the extension and future mobile clients; keep this in sync with it.

export interface TranscriptSegmentInput {
  speaker: string;
  text: string;
  timestamp: string; // ISO 8601
}

export interface ActionItemInput {
  id?: string;
  text: string;
  owner?: string;
  status?: "open" | "done";
  dueAt?: string | null;
  completedAt?: string | null;
}

export type MeetingMode = "general" | "standup" | "sales" | "one_on_one" | "interview" | "custom";
export type CaptureSource = "desktop" | "meet";
export type ProcessingMode = "local_byok" | "managed";

export interface CreateMeetingRequest {
  id: string;
  title?: string;
  mode?: MeetingMode;
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  transcript: TranscriptSegmentInput[];
  summary: string;
  actionItems: ActionItemInput[];
  /** Optional on the legacy self-hosted ingestion contract. */
  captureSource?: CaptureSource;
  /** Optional on the legacy self-hosted ingestion contract. */
  processingMode?: ProcessingMode;
}

export interface MeetingSummaryResponse {
  id: string;
  title: string;
  startedAt: string;
  summaryPreview: string;
  openActionItems: number;
}

/**
 * Renders a wire-level speaker id ("you", "them", "them-2", ...) into a
 * display label. Mirrors extension/src/types.ts's speakerLabel() — the
 * extension sends the raw wire value in every synced meeting
 * (see lib/webappSync.ts on the extension side), so this app must apply
 * the same transform at every display/export site rather than showing the
 * wire value directly.
 */
export function speakerLabel(speaker: string): string {
  if (speaker === "you") return "You";
  const match = /^them-(\d+)$/.exec(speaker);
  return match ? `Them ${match[1]}` : "Them";
}

export interface MeetingDetailResponse {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  summary: string;
  mode: MeetingMode;
  recordingAvailable: boolean;
  recordingChannels: ("mic" | "speaker")[];
  transcript: { speaker: string; text: string; timestamp: string }[];
  actionItems: {
    id: string;
    text: string;
    owner: string | null;
    status: "open" | "done";
    dueAt: string | null;
    completedAt: string | null;
    meetingId?: string;
    meetingTitle?: string;
  }[];
}
