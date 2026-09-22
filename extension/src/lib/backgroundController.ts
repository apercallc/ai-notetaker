/**
 * Ties Native Messaging events from the helper to local storage and the UI.
 * Deliberately decoupled from chrome.runtime.onMessage wiring (see
 * background.ts) so this class's actual logic can be unit tested directly
 * against a fake client, instead of only being exercisable inside a real
 * service worker.
 */
import type { BackgroundState, BackgroundToUiMessage } from "./internalMessages";
import type { HelperConnectionStatus } from "./nativeMessaging";
import { deleteMeeting as deleteLocalMeeting, getMeeting, getSettings, saveMeeting, saveSettings, updateMeeting } from "./storage";
import { normalizeWebappUrl } from "./providerTest";
import { flushWebappSyncOutbox, syncMeetingToWebapp } from "./webappSync";
import type { AudioProbeResult, AudioStatus, HelperInfo, IncomingMessage, MeetingMode, MeetingRecord, NotetakerSettings, ProviderKind } from "../types";

export interface NativeClientLike {
  connect(): Promise<void>;
  on<T extends IncomingMessage["type"]>(
    type: T,
    handler: (message: Extract<IncomingMessage, { type: T }>) => void,
  ): void;
  onStatusChange(handler: (status: HelperConnectionStatus) => void): void;
  pushSettings(settings: Pick<NotetakerSettings, "transcriptionProvider" | "summarizationProvider" | "apiKeys" | "webapp" | "defaultMeetingMode" | "customVocabulary" | "customSummaryInstructions">): void;
  startRecording(meetingId: string, meetingMode: MeetingMode): void;
  stopRecording(meetingId: string): void;
  resumeRecording(meetingId: string): void;
  discardRecording(meetingId: string): void;
  deleteMeeting(meetingId: string): void;
  testProviderKey(provider: ProviderKind, key: string): Promise<{ valid: boolean; message: string }>;
  getAudioPreflight(): Promise<AudioStatus>;
  runAudioProbe(): Promise<AudioProbeResult>;
}

function generateMeetingId(): string {
  return crypto.randomUUID();
}

export class BackgroundController {
  private settings: NotetakerSettings | null = null;
  private activeMeetingId: string | null = null;
  private recoverableMeeting: BackgroundState["recoverableMeeting"] = null;
  private helperStatus: HelperConnectionStatus = "connecting";
  private helperInfo: HelperInfo | null = null;
  private fetchImpl: typeof fetch = fetch;

  constructor(
    private client: NativeClientLike,
    private broadcast: (message: BackgroundToUiMessage) => void,
  ) {
    this.client.on("transcript_partial", (msg) => void this.handleTranscriptPartial(msg));
    this.client.on("summary_ready", (msg) => void this.handleSummaryReady(msg));
    this.client.on("error", (msg) => void this.handleError(msg));
    this.client.on("recording_started", (msg) => this.handleRecordingStarted(msg));
    this.client.on("helper_info", (msg) => this.handleHelperInfo(msg));
    this.client.on("recovered_recording", (msg) => this.handleRecoveredRecording(msg));
    this.client.onStatusChange((status) => this.handleStatusChange(status));
  }

  /** Test-only seam: real usage always uses the global fetch. */
  setFetchImpl(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  async init(): Promise<void> {
    this.settings = await getSettings();
    await this.client.connect();
    this.pushCurrentSettings();
    void flushWebappSyncOutbox(this.settings, this.fetchImpl);
  }

  async checkHelper(): Promise<BackgroundState> {
    if (this.helperStatus !== "connected" || !this.helperInfo) {
      await this.client.connect();
    }
    return this.getState();
  }

  private pushCurrentSettings(): void {
    if (!this.settings) return;
    this.client.pushSettings({
      transcriptionProvider: this.settings.transcriptionProvider,
      summarizationProvider: this.settings.summarizationProvider,
      apiKeys: this.settings.apiKeys,
      webapp: this.settings.webapp,
      defaultMeetingMode: this.settings.defaultMeetingMode,
      customVocabulary: this.settings.customVocabulary,
      customSummaryInstructions: this.settings.customSummaryInstructions,
    });
  }

  async saveSettings(settings: NotetakerSettings): Promise<void> {
    this.settings = settings;
    await saveSettings(settings);
    this.pushCurrentSettings();
    void flushWebappSyncOutbox(this.settings, this.fetchImpl);
  }

  async startRecording(meetingMode: MeetingMode = this.settings?.defaultMeetingMode ?? "general"): Promise<string> {
    if (this.helperStatus !== "connected" || !this.helperInfo) {
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId: null,
        message:
          this.helperStatus === "incompatible"
            ? "The desktop helper needs an update before it can record. Open the install page to update it."
            : "The desktop helper is not connected. Install and start it, then check again.",
      });
      return "";
    }
    if (!this.settings?.consentDisclosureAcknowledged) {
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId: null,
        message: "Acknowledge the recording consent notice in setup before recording.",
      });
      return "";
    }
    const meetingId = generateMeetingId();
    const meeting: MeetingRecord = {
      id: meetingId,
      title: `Meeting on ${new Date().toLocaleString()}`,
      startedAt: new Date().toISOString(),
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: meetingMode,
      status: "recording",
    };
    await saveMeeting(meeting);
    this.activeMeetingId = meetingId;
    try {
      this.client.startRecording(meetingId, meetingMode);
    } catch {
      meeting.status = "error";
      meeting.errorMessage = "The desktop helper is not connected. Install and start it, then try again.";
      await saveMeeting(meeting);
      this.activeMeetingId = null;
      this.broadcast({ type: "RECORDING_ERROR", meetingId, message: meeting.errorMessage });
    }
    return meetingId;
  }

  async stopRecording(meetingId: string): Promise<void> {
    const meeting = await getMeeting(meetingId);
    if (meeting) {
      meeting.status = "processing";
      await saveMeeting(meeting);
    }
    this.client.stopRecording(meetingId);
  }

  resumeRecording(meetingId: string): void {
    this.client.resumeRecording(meetingId);
    if (this.recoverableMeeting?.meetingId === meetingId) this.recoverableMeeting = null;
  }

  async discardRecording(meetingId: string): Promise<void> {
    try {
      this.client.discardRecording(meetingId);
    } catch {
      // The helper may be offline; local deletion still needs to complete.
    } finally {
      if (this.recoverableMeeting?.meetingId === meetingId) this.recoverableMeeting = null;
      await deleteLocalMeeting(meetingId);
    }
  }

  async deleteMeeting(meetingId: string): Promise<void> {
    try {
      this.client.deleteMeeting(meetingId);
    } catch {
      // The helper may be offline; local deletion still needs to complete.
    } finally {
      // The helper owns the durable raw-audio copy, but local extension data
      // must still be removable when the helper is temporarily unavailable.
      await deleteLocalMeeting(meetingId);
    }
  }

  testProviderKey(provider: ProviderKind, key: string): Promise<{ valid: boolean; message: string }> {
    return this.client.testProviderKey(provider, key);
  }

  getAudioPreflight(): Promise<AudioStatus> {
    return this.client.getAudioPreflight();
  }

  runAudioProbe(): Promise<AudioProbeResult> {
    return this.client.runAudioProbe();
  }

  getState(): BackgroundState {
    return {
      activeMeeting: this.activeMeetingId ? { id: this.activeMeetingId } : null,
      recoverableMeeting: this.recoverableMeeting,
      helperStatus: this.helperStatus,
      helperInfo: this.helperInfo,
    };
  }

  private handleStatusChange(status: HelperConnectionStatus): void {
    this.helperStatus = status;
    if (status === "helper_not_found" || status === "disconnected") this.helperInfo = null;
    this.broadcast({ type: "HELPER_STATUS", status });
    // The helper holds settings in memory only for its own process
    // lifetime (protocol: they're re-sent each time the extension
    // connects), so a transition to "connected" means it either never
    // had them (helper installed after extension startup) or lost them
    // (helper restart) — re-push. The client only fires status listeners
    // on real changes, so this is once per transition, not per message;
    // the duplicate push on the very first connect (init pushes too) is
    // an idempotent overwrite.
    if (status === "connected") this.pushCurrentSettings();
  }

  private handleHelperInfo(msg: Extract<IncomingMessage, { type: "helper_info" }>): void {
    this.helperInfo = {
      helperVersion: msg.helperVersion,
      protocolVersion: msg.protocolVersion,
      platform: msg.platform,
    };
    this.helperStatus = msg.protocolVersion === 1 ? "connected" : "incompatible";
    this.broadcast({ type: "HELPER_STATUS", status: this.helperStatus });
  }

  private handleRecordingStarted(msg: Extract<IncomingMessage, { type: "recording_started" }>): void {
    this.activeMeetingId = msg.meetingId;
  }

  private async handleTranscriptPartial(
    msg: Extract<IncomingMessage, { type: "transcript_partial" }>,
  ): Promise<void> {
    const meeting = await updateMeeting(msg.meetingId, (current) => {
      current.transcript.push({
        speaker: msg.speaker,
        text: msg.text,
        isFinal: msg.isFinal,
        timestamp: new Date().toISOString(),
      });
      return current;
    });
    if (!meeting) return;
    this.broadcast({
      type: "TRANSCRIPT_UPDATE",
      meetingId: msg.meetingId,
      speaker: msg.speaker,
      text: msg.text,
      isFinal: msg.isFinal,
    });
  }

  private async handleSummaryReady(
    msg: Extract<IncomingMessage, { type: "summary_ready" }>,
  ): Promise<void> {
    const meeting = await updateMeeting(msg.meetingId, (current) => {
      current.status = "complete";
      current.summary = msg.summary;
      const previousByFingerprint = new Map(
        current.actionItems.map((item) => [`${item.text}\u0000${item.owner ?? ""}`, item]),
      );
      current.actionItems = msg.actionItems.map((item) => {
        const previous = previousByFingerprint.get(`${item.text}\u0000${item.owner ?? ""}`);
        return {
          ...item,
          id: previous?.id ?? crypto.randomUUID(),
          status: previous?.status ?? "open",
          dueAt: previous?.dueAt ?? null,
          completedAt: previous?.completedAt ?? null,
        };
      });
      current.endedAt = new Date().toISOString();
      return current;
    });
    if (!meeting) return;
    if (this.activeMeetingId === msg.meetingId) this.activeMeetingId = null;
    this.broadcast({
      type: "SUMMARY_READY",
      meetingId: msg.meetingId,
      summary: msg.summary,
      actionItems: msg.actionItems,
    });
    await this.syncToWebapp(meeting);
  }

  private async handleError(msg: Extract<IncomingMessage, { type: "error" }>): Promise<void> {
    if (msg.meetingId) {
      const meeting = await getMeeting(msg.meetingId);
      if (meeting) {
        // A failed transcription chunk is already durable and queued by the
        // helper. It is not a failed meeting: keep the recording active so a
        // later retry can append the recovered transcript and the user can
        // still stop normally.
        if (
          msg.message.startsWith("transcription failed, queued for retry:") ||
          msg.message.startsWith("transcript could not be persisted; queued for retry:") ||
          msg.message.startsWith("summary deferred until transcription retries finish") ||
          msg.message.startsWith("summarization failed:")
        ) {
          this.broadcast({ type: "PROCESSING_WARNING", meetingId: msg.meetingId, message: msg.message });
          return;
        }
        await updateMeeting(msg.meetingId, (current) => {
          current.status = "error";
          current.errorMessage = msg.message;
          return current;
        });
      }
      if (this.activeMeetingId === msg.meetingId) this.activeMeetingId = null;
    }
    this.broadcast({ type: "RECORDING_ERROR", meetingId: msg.meetingId, message: msg.message });
  }

  private handleRecoveredRecording(
    msg: Extract<IncomingMessage, { type: "recovered_recording" }>,
  ): void {
    this.recoverableMeeting = { meetingId: msg.meetingId, startedAt: msg.startedAt };
    this.broadcast({
      type: "RECOVERABLE_RECORDING",
      meetingId: msg.meetingId,
      startedAt: msg.startedAt,
    });
  }

  private async syncToWebapp(meeting: MeetingRecord): Promise<void> {
    const webapp = this.settings?.webapp;
    if (!webapp) return;
    const normalized = normalizeWebappUrl(webapp.url);
    if (!normalized) {
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId: meeting.id,
        message: "Meeting saved locally, but the configured webapp URL is invalid or not HTTPS.",
      });
      return;
    }
    await syncMeetingToWebapp(meeting, { webapp }, this.fetchImpl);
  }
}
