/**
 * Types mirroring docs/native-messaging-protocol.md and docs/webapp-api.md.
 * Keep these in sync with those docs — they are the contract, not this file.
 */

import type { CalendarConnection } from "./lib/calendar";

export type TranscriptionProvider = "deepgram" | "groq";
export type SummarizationProvider = "claude" | "gemini" | "deepseek";
export type ProviderKind = TranscriptionProvider | SummarizationProvider;
export type MeetingMode = "general" | "standup" | "sales" | "one_on_one" | "interview" | "custom";
export type ErrorRecoveryCategory = "retry" | "check_provider_key" | "check_audio" | "check_billing" | "install_helper" | "update_helper" | "sign_in";
export type LiveTranscriptStatus = "connecting" | "available" | "unavailable" | "not_supported";


/** Maps stable helper error codes to safe actions without exposing provider internals. */
export function errorRecoveryCategory(code: string): ErrorRecoveryCategory {
  switch (code) {
    case "provider_auth_failed":
      return "check_provider_key";
    case "provider_rate_limited":
    case "provider_unreachable":
      return "retry";
    case "device_not_found":
      return "check_audio";
    case "helper_not_paired":
      // The host answered, so installation is present. The client clears its
      // stale local token and re-pairs on the next connection attempt.
      return "retry";
    case "protocol_incompatible":
      return "update_helper";
    case "managed_auth_required":
      return "sign_in";
    case "managed_entitlement_unavailable":
      return "check_billing";
    default:
      return "retry";
  }
}
/**
 * `desktop` and `meet` are retained for old stored meetings and helpers.
 * New recordings should use the explicit source names.
 */
export type CaptureSource = "desktop" | "meet" | "desktop_loopback" | "desktop_virtual_device" | "meet_tab";
export type BrowserAudioChannel = "mic" | "speaker";
export type ActionItemStatus = "open" | "done";

export type ProcessingMode =
  | { kind: "local_byok" }
  | { kind: "managed"; accountId: string; workspaceId: string; plan: string };

export interface ManagedServiceConfig {
  baseUrl: string;
  accessToken: string;
  accountId: string;
  workspaceId: string;
  plan: string;
}

export interface ManagedEntitlements {
  plan: string;
  status: string;
  used: number;
  limit: number;
  remaining: number;
  canProcess: boolean;
  inPaymentGrace: boolean;
}

export interface CaptureChannelMetadata {
  channel: BrowserAudioChannel;
  sampleRateHz: number;
  bytesPersisted: number;
  startedAt: string;
  endedAt?: string;
}

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

/** A user-owned Google OAuth connection, stored only in chrome.storage.local. */
export interface DriveConnection {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface DriveExportState {
  status: "pending" | "exported" | "error";
  fileId?: string;
  webViewLink?: string;
  exportedAt?: string;
  errorMessage?: string;
}

export interface AudioStatus {
  platform: string;
  driver: string;
  driverInstalled: boolean;
  microphone: string | null;
  speaker: string | null;
  ready: boolean;
  guidance: string;
  nativeLoopback: boolean;
  virtualDeviceFallback: boolean;
  permissionRequired: boolean;
}

export interface AudioProbeResult {
  micFrames: number;
  speakerFrames: number;
  passed: boolean;
  message: string;
}

export interface CaptureCapabilities {
  platform: HelperInfo["platform"];
  nativeLoopback: boolean;
  microphone: boolean;
  virtualDeviceFallback: boolean;
  permissionRequired: boolean;
  guidance: string;
}

export interface HelperInfo {
  helperVersion: string;
  protocolVersion: number;
  platform: "macos" | "windows" | "linux" | "unknown";
}

export interface NotetakerSettings {
  transcriptionProvider: TranscriptionProvider;
  summarizationProvider: SummarizationProvider;
  apiKeys: ProviderApiKeys;
  webapp: WebappConfig | null;
  processingMode: ProcessingMode;
  managedService: ManagedServiceConfig | null;
  defaultMeetingMode: MeetingMode;
  customVocabulary: string[];
  customSummaryInstructions: string;
  onboardingComplete: boolean;
  consentDisclosureAcknowledged: boolean;
  /** Show the floating notes widget on Google Meet calls. */
  showMeetWidget: boolean;
  /** Try to start notes automatically when a Google Meet call tab is joined. */
  autoRecordOnMeetJoin: boolean;
  /** Show a one-tap-copy attendee disclosure notice while recording a Meet call. */
  meetDisclosureNotice: boolean;
  /** Automatically create an expiring share link for finished notes (Hosted AI or connected webapp). */
  autoShareNotesWithAttendees: boolean;
  /** Open the notes in a new tab as soon as they are ready, not just notify. */
  openNotesWhenReady: boolean;
  /** Notify shortly before a calendar event with a Google Meet link starts. */
  calendarReminders: boolean;
  calendar: CalendarConnection | null;
  drive: DriveConnection | null;
}

export const DEFAULT_SETTINGS: NotetakerSettings = {
  transcriptionProvider: "deepgram",
  summarizationProvider: "claude",
  apiKeys: {},
  webapp: null,
  processingMode: { kind: "local_byok" },
  managedService: null,
  defaultMeetingMode: "general",
  customVocabulary: [],
  customSummaryInstructions: "",
  onboardingComplete: false,
  consentDisclosureAcknowledged: false,
  showMeetWidget: true,
  autoRecordOnMeetJoin: true,
  meetDisclosureNotice: false,
  autoShareNotesWithAttendees: false,
  openNotesWhenReady: true,
  calendarReminders: true,
  calendar: null,
  drive: null,
};

/** A flagged moment as sent to the helper at stop time so the summary can weigh it. */
export interface FlaggedMomentWire {
  offsetMs: number;
  note: string;
  /** How far through the call the flag sits (0-100), measured when the user stopped. */
  positionPercent?: number;
}

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
  /** Absent on segments recorded before this field existed. */
  utteranceId?: number;
  /** Milliseconds since the call started, when available from browser capture. */
  offsetMs?: number;
}

export interface ActionItem {
  id?: string;
  text: string;
  owner?: string;
  status?: ActionItemStatus;
  dueAt?: string | null;
  completedAt?: string | null;
}

/** A moment the user flagged during a call, stored as an offset so it survives clock changes. */
export interface Bookmark {
  id: string;
  /** Milliseconds since the meeting started. */
  offsetMs: number;
  note: string;
  createdAt: string;
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
  liveTranscriptStatus?: LiveTranscriptStatus;
  errorMessage?: string;
  attendees?: string[];
  bookmarks?: Bookmark[];
  driveExport?: DriveExportState;
  /** Explicit source/mode fields are optional for backward compatibility. */
  captureSource?: CaptureSource;
  processingMode?: ProcessingMode;
  consentAcknowledged?: boolean;
  captureChannels?: CaptureChannelMetadata[];
  /** Attendee share link auto-created for this meeting (auto-share setting). */
  attendeeShare?: {
    shareUrl: string;
    expiresAt: string;
    createdAt: string;
  };
  managedProcessing?: {
    uploadId?: string;
    jobId?: string;
    /** Statuses the hosted API may add later are stored verbatim; consumers map unknown ones to "processing". */
    status: "not_started" | "uploading" | "queued" | "processing" | "complete" | "error" | (string & {});
    errorMessage?: string;
  };
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
      processingMode: ProcessingMode;
      managedService: ManagedServiceConfig | null;
      defaultMeetingMode: MeetingMode;
      customVocabulary: string[];
      customSummaryInstructions: string;
    }
  | { type: "start_recording"; meetingId: string; meetingMode: MeetingMode; title?: string; captureSource?: CaptureSource; processingMode?: ProcessingMode }
  | { type: "audio_chunk"; meetingId: string; channel: BrowserAudioChannel; sampleRateHz: number; pcm16Base64: string }
  | { type: "stop_recording"; meetingId: string; flaggedMoments?: FlaggedMomentWire[] }
  | { type: "resume_recording"; meetingId: string }
  | { type: "discard_recording"; meetingId: string }
  | { type: "delete_meeting"; meetingId: string }
  | { type: "test_provider_key"; provider: ProviderKind; key: string }
  | { type: "audio_preflight" }
  | { type: "audio_probe" };

// ---- Native Messaging: helper -> extension ----

export type IncomingMessage =
  | { type: "paired"; pairingToken: string }
  | { type: "helper_info"; helperVersion: string; protocolVersion: number; platform: HelperInfo["platform"] }
  | { type: "recording_started"; meetingId: string }
  | { type: "recording_stopped"; meetingId: string }
  | {
      type: "transcript_partial";
      meetingId: string;
      speaker: Speaker;
      text: string;
      isFinal: boolean;
      utteranceId: number;
    }
  | {
      type: "summary_ready";
      meetingId: string;
      summary: string;
      actionItems: ActionItem[];
    }
  | { type: "error"; meetingId: string | null; code: string; message: string; recovery?: ErrorRecoveryCategory; retryable?: boolean; retryAfterSeconds?: number }
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
      nativeLoopback: boolean;
      virtualDeviceFallback: boolean;
      permissionRequired: boolean;
    }
  | { type: "audio_probe_result"; micFrames: number; speakerFrames: number; passed: boolean; message: string }
  | { type: "capture_capabilities"; capabilities: CaptureCapabilities }
  | { type: "managed_job_status"; meetingId: string; jobId: string; status: "queued" | "processing" | "complete" | "error" | (string & {}); message?: string; summary?: string; actionItems?: ActionItem[] };

export function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const isString = (key: string): boolean => typeof message[key] === "string";
  const hasNonEmptyString = (key: string): boolean => typeof message[key] === "string" && (message[key] as string).length > 0;
  const isNullableString = (key: string): boolean => message[key] === null || isString(key);
  const isSpeaker = (speaker: unknown): speaker is Speaker =>
    speaker === "you" || speaker === "them" || (typeof speaker === "string" && /^them-\d+$/.test(speaker));
  const isProvider = (provider: unknown): provider is ProviderKind =>
    provider === "deepgram" || provider === "groq" || provider === "claude" || provider === "gemini" || provider === "deepseek";
  const isRecovery = (recovery: unknown): recovery is ErrorRecoveryCategory =>
    recovery === "retry" || recovery === "check_provider_key" || recovery === "check_audio" || recovery === "check_billing" || recovery === "install_helper" || recovery === "update_helper" || recovery === "sign_in";
  const isActionItem = (item: unknown): item is ActionItem => {
    if (typeof item !== "object" || item === null) return false;
    const action = item as Record<string, unknown>;
    return (
      typeof action.text === "string" &&
      (action.id === undefined || typeof action.id === "string") &&
      (action.owner === undefined || typeof action.owner === "string") &&
      (action.status === undefined || action.status === "open" || action.status === "done") &&
      (action.dueAt === undefined || action.dueAt === null || typeof action.dueAt === "string") &&
      (action.completedAt === undefined || action.completedAt === null || typeof action.completedAt === "string")
    );
  };

  switch (message.type) {
    case "paired":
      return hasNonEmptyString("pairingToken");
    case "helper_info":
      return isString("helperVersion") && typeof message.protocolVersion === "number" && Number.isSafeInteger(message.protocolVersion) &&
        (message.platform === "macos" || message.platform === "windows" || message.platform === "linux" || message.platform === "unknown");
    case "recording_started":
    case "recording_stopped":
      return hasNonEmptyString("meetingId");
    case "transcript_partial":
      return hasNonEmptyString("meetingId") && isSpeaker(message.speaker) && isString("text") &&
        typeof message.isFinal === "boolean" && typeof message.utteranceId === "number" && Number.isInteger(message.utteranceId);
    case "summary_ready":
      return hasNonEmptyString("meetingId") && isString("summary") && Array.isArray(message.actionItems) &&
        message.actionItems.length <= 1_000 && message.actionItems.every(isActionItem);
    case "error":
      return isNullableString("meetingId") && isString("code") && isString("message") &&
        (message.recovery === undefined || isRecovery(message.recovery)) &&
        (message.retryable === undefined || typeof message.retryable === "boolean") &&
        (message.retryAfterSeconds === undefined || (Number.isSafeInteger(message.retryAfterSeconds) && (message.retryAfterSeconds as number) >= 0 && (message.retryAfterSeconds as number) <= 86_400));
    case "recovered_recording":
      return hasNonEmptyString("meetingId") && isString("startedAt");
    case "provider_key_test_result":
      return isProvider(message.provider) && typeof message.valid === "boolean" && isString("message");
    case "audio_status":
      return isString("platform") && isString("driver") && typeof message.driverInstalled === "boolean" &&
        isNullableString("microphone") && isNullableString("speaker") && typeof message.ready === "boolean" && isString("guidance") &&
        typeof message.nativeLoopback === "boolean" && typeof message.virtualDeviceFallback === "boolean" && typeof message.permissionRequired === "boolean";
    case "audio_probe_result":
      return Number.isSafeInteger(message.micFrames) && (message.micFrames as number) >= 0 &&
        Number.isSafeInteger(message.speakerFrames) && (message.speakerFrames as number) >= 0 &&
        typeof message.passed === "boolean" && isString("message");
    case "capture_capabilities": {
      const capabilities = message.capabilities;
      if (typeof capabilities !== "object" || capabilities === null) return false;
      const value = capabilities as Record<string, unknown>;
      return (value.platform === "macos" || value.platform === "windows" || value.platform === "linux" || value.platform === "unknown") &&
        typeof value.nativeLoopback === "boolean" && typeof value.microphone === "boolean" &&
        typeof value.virtualDeviceFallback === "boolean" && typeof value.permissionRequired === "boolean" &&
        typeof value.guidance === "string";
    }
    case "managed_job_status":
      // The helper sends an empty jobId only on the upload-failure path
      // (status "error") — every other status must identify a real job.
      // Accept any non-empty status string: a hosted API that adds a new
      // intermediate state must not have its transitions silently dropped
      // (the controller maps unknown statuses to "processing"), while an
      // empty status is never meaningful on this message.
      return hasNonEmptyString("meetingId") && (message.status === "error" ? isString("jobId") : hasNonEmptyString("jobId")) &&
        hasNonEmptyString("status") &&
        (message.message === undefined || isString("message")) &&
        (message.summary === undefined || isString("summary")) &&
        (message.actionItems === undefined || (Array.isArray(message.actionItems) && message.actionItems.length <= 1_000 && message.actionItems.every(isActionItem)));
    default:
      return false;
  }
}
