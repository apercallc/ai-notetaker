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

export interface CreateMeetingRequest {
  id: string;
  title?: string;
  mode?: MeetingMode;
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  transcript: TranscriptSegmentInput[];
  summary: string;
  actionItems: ActionItemInput[];
}

export interface MeetingSummaryResponse {
  id: string;
  title: string;
  startedAt: string;
  summaryPreview: string;
  openActionItems: number;
}

export interface MeetingDetailResponse {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  summary: string;
  mode: MeetingMode;
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
