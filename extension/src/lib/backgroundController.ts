/**
 * Ties Native Messaging events from the helper to local storage and the UI.
 * Deliberately decoupled from chrome.runtime.onMessage wiring (see
 * background.ts) so this class's actual logic can be unit tested directly
 * against a fake client, instead of only being exercisable inside a real
 * service worker.
 */
import type { BackgroundState, BackgroundToUiMessage } from "./internalMessages";
import type { HelperConnectionStatus } from "./nativeMessaging";
import { getMeeting, getSettings, saveMeeting, saveSettings, updateMeeting } from "./storage";
import { normalizeWebappUrl } from "./providerTest";
import type { IncomingMessage, MeetingRecord, NotetakerSettings, ProviderKind } from "../types";

const WEBAPP_SYNC_TIMEOUT_MS = 15_000;

export interface NativeClientLike {
  connect(): Promise<void>;
  on<T extends IncomingMessage["type"]>(
    type: T,
    handler: (message: Extract<IncomingMessage, { type: T }>) => void,
  ): void;
  onStatusChange(handler: (status: HelperConnectionStatus) => void): void;
  pushSettings(settings: Pick<NotetakerSettings, "transcriptionProvider" | "summarizationProvider" | "apiKeys" | "webapp">): void;
  startRecording(meetingId: string): void;
  stopRecording(meetingId: string): void;
  resumeRecording(meetingId: string): void;
  discardRecording(meetingId: string): void;
  testProviderKey(provider: ProviderKind, key: string): Promise<{ valid: boolean; message: string }>;
}

function generateMeetingId(): string {
  return crypto.randomUUID();
}

export class BackgroundController {
  private settings: NotetakerSettings | null = null;
  private activeMeetingId: string | null = null;
  private recoverableMeeting: BackgroundState["recoverableMeeting"] = null;
  private helperStatus: HelperConnectionStatus = "connecting";
  private fetchImpl: typeof fetch = fetch;

  constructor(
    private client: NativeClientLike,
    private broadcast: (message: BackgroundToUiMessage) => void,
  ) {
    this.client.on("transcript_partial", (msg) => void this.handleTranscriptPartial(msg));
    this.client.on("summary_ready", (msg) => void this.handleSummaryReady(msg));
    this.client.on("error", (msg) => void this.handleError(msg));
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
  }

  private pushCurrentSettings(): void {
    if (!this.settings) return;
    this.client.pushSettings({
      transcriptionProvider: this.settings.transcriptionProvider,
      summarizationProvider: this.settings.summarizationProvider,
      apiKeys: this.settings.apiKeys,
      webapp: this.settings.webapp,
    });
  }

  async saveSettings(settings: NotetakerSettings): Promise<void> {
    this.settings = settings;
    await saveSettings(settings);
    this.pushCurrentSettings();
  }

  async startRecording(): Promise<string> {
    const meetingId = generateMeetingId();
    const meeting: MeetingRecord = {
      id: meetingId,
      title: `Meeting on ${new Date().toLocaleString()}`,
      startedAt: new Date().toISOString(),
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      status: "recording",
    };
    await saveMeeting(meeting);
    this.activeMeetingId = meetingId;
    try {
      this.client.startRecording(meetingId);
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

  discardRecording(meetingId: string): void {
    this.client.discardRecording(meetingId);
    if (this.recoverableMeeting?.meetingId === meetingId) this.recoverableMeeting = null;
  }

  testProviderKey(provider: ProviderKind, key: string): Promise<{ valid: boolean; message: string }> {
    return this.client.testProviderKey(provider, key);
  }

  getState(): BackgroundState {
    return {
      activeMeeting: this.activeMeetingId ? { id: this.activeMeetingId } : null,
      recoverableMeeting: this.recoverableMeeting,
      helperStatus: this.helperStatus,
    };
  }

  private handleStatusChange(status: HelperConnectionStatus): void {
    this.helperStatus = status;
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
      current.actionItems = msg.actionItems;
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
        if (msg.message.startsWith("transcription failed, queued for retry:")) {
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBAPP_SYNC_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${normalized}/api/meetings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${webapp.token}`,
        },
        body: JSON.stringify({
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          endedAt: meeting.endedAt,
          transcript: meeting.transcript,
          summary: meeting.summary,
          actionItems: meeting.actionItems,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`webapp returned HTTP ${response.status}`);
    } catch {
      // Local save already succeeded (per the raw-audio/local-first
      // resilience guarantee this mirrors) — a webapp sync failure is
      // logged, not fatal. A retry-on-next-sync pass is a fast-follow, not
      // required for the local-first experience to work.
      console.warn(`Failed to sync meeting ${meeting.id} to webapp`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
