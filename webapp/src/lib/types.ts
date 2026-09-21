// Shapes match docs/webapp-api.md exactly — that file is the contract with
// the extension and future mobile clients; keep this in sync with it.

export interface TranscriptSegmentInput {
  speaker: string;
  text: string;
  timestamp: string; // ISO 8601
}

export interface ActionItemInput {
  text: string;
  owner?: string;
}

export interface CreateMeetingRequest {
  id: string;
  title?: string;
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
}

export interface MeetingDetailResponse {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  summary: string;
  transcript: { speaker: string; text: string; timestamp: string }[];
  actionItems: { text: string; owner: string | null }[];
}
