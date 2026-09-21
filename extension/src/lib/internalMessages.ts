/**
 * Internal message protocol between the UI pages (popup/settings/onboarding)
 * and the background service worker. Distinct from
 * docs/native-messaging-protocol.md, which is background <-> helper only —
 * UI pages never talk to the helper directly.
 */
import type { HelperConnectionStatus } from "./nativeMessaging";
import type { ActionItem, NotetakerSettings, ProviderKind, Speaker } from "../types";

export type UiToBackgroundMessage =
  | { type: "GET_STATE" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING"; meetingId: string }
  | { type: "SAVE_SETTINGS"; settings: NotetakerSettings }
  | { type: "RESUME_RECORDING"; meetingId: string }
  | { type: "DISCARD_RECORDING"; meetingId: string }
  | { type: "TEST_PROVIDER_KEY"; provider: ProviderKind; key: string };

export interface BackgroundState {
  activeMeeting: { id: string } | null;
  recoverableMeeting: { meetingId: string; startedAt: string } | null;
  helperStatus: HelperConnectionStatus;
}

export type BackgroundToUiMessage =
  | { type: "STATE"; state: BackgroundState }
  | { type: "TRANSCRIPT_UPDATE"; meetingId: string; speaker: Speaker; text: string; isFinal: boolean }
  | { type: "SUMMARY_READY"; meetingId: string; summary: string; actionItems: ActionItem[] }
  | { type: "PROCESSING_WARNING"; meetingId: string; message: string }
  | { type: "RECORDING_ERROR"; meetingId: string | null; message: string }
  | { type: "RECOVERABLE_RECORDING"; meetingId: string; startedAt: string }
  | { type: "HELPER_STATUS"; status: HelperConnectionStatus };
