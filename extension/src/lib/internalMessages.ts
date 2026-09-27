/**
 * Internal message protocol between the UI pages (popup/settings/onboarding)
 * and the background service worker. Distinct from
 * docs/native-messaging-protocol.md, which is background <-> helper only —
 * UI pages never talk to the helper directly.
 */
import type { HelperConnectionStatus } from "./nativeMessaging";
import type { Shortcuts } from "./shortcuts";
import type { ActionItem, AudioProbeResult, AudioStatus, Bookmark, BrowserAudioChannel, CaptureSource, DriveExportState, ErrorRecoveryCategory, HelperInfo, LiveTranscriptStatus, MeetingMode, MeetingRecord, NotetakerSettings, ProviderKind, Speaker } from "../types";

export type UiToBackgroundMessage =
  | { type: "GET_STATE" }
  | { type: "CHECK_HELPER" }
  | { type: "GET_AUDIO_PREFLIGHT" }
  | { type: "RUN_AUDIO_PROBE" }
  | { type: "START_RECORDING"; meetingMode?: MeetingMode; captureSource?: CaptureSource; tabId?: number; titleHint?: string }
  | { type: "MEET_AUDIO_CHUNK"; meetingId: string; channel: BrowserAudioChannel; sampleRateHz: number; pcm16Base64: string; tabId?: number }
  | { type: "MEET_CAPTURE_ERROR"; meetingId: string; message: string }
  | { type: "MEET_LIVE_TRANSCRIPT_STATUS"; meetingId: string; status: LiveTranscriptStatus }
  | { type: "MEET_LIVE_TRANSCRIPT_UPDATE"; meetingId: string; channel: BrowserAudioChannel; speaker: Speaker; text: string; isFinal: boolean; utteranceId: number; offsetMs: number }
  | { type: "STOP_RECORDING"; meetingId: string }
  | { type: "ADD_BOOKMARK"; meetingId: string; note?: string }
  | { type: "GET_WIDGET_STATE" }
  | { type: "SAVE_WIDGET_POSITION"; position: { x: number; y: number } }
  | { type: "OPEN_MEETING"; meetingId: string }
  | { type: "RETRY_MEETING_PROCESSING"; meetingId: string }
  | { type: "OPEN_PAGE"; page: "onboarding" | "settings" | "microphone" | "shortcuts" }
  | { type: "RETRY_DRIVE_EXPORT"; meetingId: string }
  | { type: "SAVE_SETTINGS"; settings: NotetakerSettings }
  | { type: "RESUME_RECORDING"; meetingId: string }
  | { type: "DISCARD_RECORDING"; meetingId: string }
  | { type: "DELETE_MEETING"; meetingId: string }
  | { type: "TEST_PROVIDER_KEY"; provider: ProviderKind; key: string; desktop?: boolean };

export interface BackgroundState {
  activeMeeting: { id: string } | null;
  recoverableMeeting: { meetingId: string; startedAt: string } | null;
  helperStatus: HelperConnectionStatus;
  helperInfo: HelperInfo | null;
}

/** Just enough of a meeting for the in-call widget; never the full transcript. */
export interface WidgetMeeting {
  id: string;
  title: string;
  startedAt: string;
  status: MeetingRecord["status"];
  captureSource?: CaptureSource;
  liveTranscriptStatus?: LiveTranscriptStatus;
  errorMessage?: string;
  bookmarks: Bookmark[];
  transcript: Array<{ speaker: Speaker; text: string; isFinal: boolean; utteranceId?: number }>;
}

export interface WidgetState {
  helperStatus: HelperConnectionStatus;
  /** Where notes are written: the user's own provider keys, or Hosted AI. */
  processingKind: "local_byok" | "managed";
  onboardingComplete: boolean;
  consentAcknowledged: boolean;
  widgetEnabled: boolean;
  shortcuts: Shortcuts;
  /** Title of the calendar event running right now, when a calendar is connected. */
  callTitle: string | null;
  /** Where the user last dropped the widget; the content script has no storage access of its own. */
  position: { x: number; y: number } | null;
  defaultMeetingMode: MeetingMode;
  /** Show the one-tap-copy attendee disclosure notice while recording. */
  disclosureNoticeEnabled: boolean;
  active: WidgetMeeting | null;
  /** Most recent finished (or finishing) meeting, so the widget can show "notes ready". */
  latest: Omit<WidgetMeeting, "bookmarks" | "transcript"> & { endedAt: string | null } | null;
}

export interface AudioPreflightResponse {
  status: AudioStatus;
}

export interface AudioProbeResponse {
  result: AudioProbeResult;
}

export type BackgroundToUiMessage =
  | { type: "STATE"; state: BackgroundState }
  | { type: "TRANSCRIPT_UPDATE"; meetingId: string; speaker: Speaker; text: string; isFinal: boolean; utteranceId: number }
  | { type: "SUMMARY_READY"; meetingId: string; summary: string; actionItems: ActionItem[] }
  | { type: "PROCESSING_WARNING"; meetingId: string; message: string; recovery?: ErrorRecoveryCategory }
  /** `phase: "start"` marks a recording that never began: the person who asked for it is told in place, not by a toolbar badge. */
  | { type: "RECORDING_ERROR"; meetingId: string | null; message: string; recovery?: ErrorRecoveryCategory; phase?: "start" }
  | { type: "RECOVERABLE_RECORDING"; meetingId: string; startedAt: string }
  | { type: "DRIVE_EXPORT"; meetingId: string; status: DriveExportState["status"]; webViewLink?: string; message?: string }
  | { type: "HELPER_STATUS"; status: HelperConnectionStatus }
  | { type: "MEETING_STATE_CHANGED"; meetingId: string }
  /** Chrome requires one toolbar/shortcut invocation before tab audio capture. */
  | { type: "CAPTURE_INVOCATION_REQUIRED"; tabId: number };
