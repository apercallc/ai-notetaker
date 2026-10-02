/**
 * Ties Native Messaging events from the helper to local storage and the UI.
 * Deliberately decoupled from chrome.runtime.onMessage wiring (see
 * background.ts) so this class's actual logic can be unit tested directly
 * against a fake client, instead of only being exercisable inside a real
 * service worker.
 */
import type { BackgroundState, BackgroundToUiMessage, WidgetState } from "./internalMessages";
import { flaggedMomentsFor, withBookmark } from "./bookmarks";
import { readShortcuts } from "./shortcuts";
import { getWidgetPosition } from "./storage";
import type { HelperConnectionStatus } from "./nativeMessaging";
import { clearTranscriptionCache, deleteMeeting as deleteLocalMeeting, getMeeting, getSettings, getTranscriptionSegment, listMeetings, saveMeeting, saveSettings, saveTranscriptionSegment, updateMeeting } from "./storage";
import { normalizeWebappUrl } from "./providerTest";
import { testProviderKeyDirect } from "./testProviderKey";
import { flushWebappSyncOutbox, syncMeetingToWebapp } from "./webappSync";
import { findCurrentEvent } from "./calendar";
import { exportMeetingToDrive } from "./drive";
import { clearBrowserMeetChunks, appendBrowserMeetChunk, streamBrowserMeetChunks, lastBrowserMeetSequence } from "../meet/browserStorage";
import { processBrowserMeetRecording } from "../meet/browserProcessing";
import { isHostedQuotaExhaustion, notifyHostedQuotaExhausted, notifyHostedQuotaLow } from "./hostedQuotaNotice";
import { managedAudioChunkSource } from "../meet/managedAudioChunks";
import { createManagedMeetingShare, exportManagedMeetingToGoogleDrive, getManagedEntitlements, getManagedJob, ManagedAuthError, registerManagedMeeting, uploadManagedMeeting } from "./managedClient";
import { reportManagedError } from "./errorReport";
import { errorRecoveryCategory, type AudioProbeResult, type AudioStatus, type BrowserAudioChannel, type CaptureSource, type FlaggedMomentWire, type HelperInfo, type IncomingMessage, type MeetingMode, type MeetingRecord, type NotetakerSettings, type ProcessingMode, type ProviderKind, type TranscriptSegment, type LiveTranscriptStatus } from "../types";

export interface NativeClientLike {
  connect(): Promise<void>;
  on<T extends IncomingMessage["type"]>(
    type: T,
    handler: (message: Extract<IncomingMessage, { type: T }>) => void,
  ): void;
  onStatusChange(handler: (status: HelperConnectionStatus) => void): void;
  pushSettings(settings: Pick<NotetakerSettings, "transcriptionProvider" | "summarizationProvider" | "apiKeys" | "webapp" | "defaultMeetingMode" | "customVocabulary" | "customSummaryInstructions"> & Partial<Pick<NotetakerSettings, "processingMode" | "managedService">>): void;
  startRecording(meetingId: string, meetingMode: MeetingMode, captureSource?: CaptureSource, processingMode?: ProcessingMode, title?: string): void;
  sendAudioChunk?: (meetingId: string, channel: BrowserAudioChannel, pcm16: Uint8Array, sampleRateHz?: number) => void;
  stopRecording(meetingId: string, flaggedMoments?: FlaggedMomentWire[]): void;
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

function managedMeetingMatchesService(meeting: MeetingRecord, service: NotetakerSettings["managedService"]): boolean {
  return Boolean(
    service &&
      meeting.processingMode?.kind === "managed" &&
      meeting.processingMode.accountId === service.accountId &&
      meeting.processingMode.workspaceId === service.workspaceId,
  );
}

/**
 * Helper errors that mean "still working on it", not "this meeting is dead".
 * Kept in lockstep with the helper's pipeline by a test on the Rust side —
 * see handleError below.
 */
const RETRYABLE_HELPER_ERROR_PREFIXES = [
  "transcription failed, queued for retry:",
  "transcript could not be persisted; queued for retry:",
  "summary deferred until transcription retries finish",
  "summarization failed:",
] as const;

/** The hosted job itself failed (not the polling): its upload cannot be reused. */
class HostedJobFailedError extends Error {}

const MANAGED_JOB_POLL_ATTEMPTS = 300; // x 2 s = 10 minutes

export class BackgroundController {
  private settings: NotetakerSettings | null = null;
  private activeMeetingId: string | null = null;
  private recoverableMeeting: BackgroundState["recoverableMeeting"] = null;
  private helperStatus: HelperConnectionStatus = "connecting";
  private helperInfo: HelperInfo | null = null;
  private fetchImpl: typeof fetch = fetch;
  private startInFlight: Promise<string> | null = null;
  private currentEventCache: { at: number; title: string | null } | null = null;
  private currentEventRefresh: Promise<void> | null = null;
  private managedMeetDrain: Promise<void> | null = null;
  private readonly meetChunkSequence = new Map<string, number>();
  private readonly meetChunkWrites = new Map<string, Promise<void>>();

  constructor(
    private client: NativeClientLike,
    private broadcast: (message: BackgroundToUiMessage) => void,
  ) {
    this.client.on("transcript_partial", (msg) => this.guardHelperEvent("transcript_partial", msg.meetingId, this.handleTranscriptPartial(msg)));
    this.client.on("summary_ready", (msg) => this.guardHelperEvent("summary_ready", msg.meetingId, this.handleSummaryReady(msg)));
    this.client.on("managed_job_status", (msg) => this.guardHelperEvent("managed_job_status", msg.meetingId, this.handleManagedJobStatus(msg)));
    this.client.on("error", (msg) => this.guardHelperEvent("error", msg.meetingId, this.handleError(msg)));
    this.client.on("recording_started", (msg) => this.handleRecordingStarted(msg));
    this.client.on("recording_stopped", (msg) => this.guardHelperEvent("recording_stopped", msg.meetingId, this.handleRecordingStopped(msg)));
    this.client.on("helper_info", (msg) => this.handleHelperInfo(msg));
    this.client.on("recovered_recording", (msg) => this.handleRecoveredRecording(msg));
    this.client.onStatusChange((status) => this.handleStatusChange(status));
  }

  /**
   * Helper events are handled fire-and-forget. A storage failure inside a handler
   * (quota, a closed database) must not become an unhandled rejection that leaves
   * the meeting looking healthy: log it and tell open views.
   */
  private guardHelperEvent(type: string, meetingId: string | null | undefined, handling: Promise<unknown> | void): void {
    if (!handling) return;
    void handling.catch((error: unknown) => {
      console.warn(`Handling helper event ${type} failed`, error);
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId: meetingId ?? null,
        message: "AI Notetaker could not save an update from the helper. Your recording is safe; reopen the extension if this keeps happening.",
      });
    });
  }

  /** Test-only seam: real usage always uses the global fetch. */
  setFetchImpl(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  async init(): Promise<void> {
    this.settings = await getSettings();
    const latest = await listMeetings(1);
    const active = latest.find((meeting) => meeting.status === "recording" && meeting.captureSource === "meet");
    if (active) {
      this.activeMeetingId = active.id;
      this.meetChunkSequence.set(active.id, (await lastBrowserMeetSequence(active.id)) + 1);
    }
    this.pushCurrentSettings();
    // Meet recording is extension-owned and does not require the desktop
    // helper. Start its connection after local state has hydrated so a cold
    // helper handshake cannot hold the popup (or Meet) behind it.
    void this.client.connect().catch((error) => {
      console.warn("Helper connection could not start", error);
    });
    void flushWebappSyncOutbox(this.settings, this.fetchImpl);
    void this.drainManagedMeetOutbox().catch((error) => {
      console.warn("Managed Meet recovery could not start", error);
    });
    void this.resumeInterruptedLocalMeetProcessing().catch((error) => {
      console.warn("Meet processing recovery could not start", error);
    });
  }

  /**
   * A long transcription/summary run can outlive the service worker (MV3 ends
   * it after a few minutes). The raw chunks are only cleared on success, so a
   * meeting left in "processing" with no run in this fresh worker is resumed
   * from storage rather than stuck forever.
   */
  private async resumeInterruptedLocalMeetProcessing(): Promise<void> {
    for (const meeting of await listMeetings()) {
      if (
        meeting.captureSource !== "meet" ||
        meeting.status !== "processing" ||
        (meeting.processingMode?.kind ?? "local_byok") !== "local_byok" ||
        this.meetFinishRuns.has(meeting.id)
      ) continue;
      await this.finishBrowserMeetRecording(meeting.id, meeting);
    }
  }

  /**
   * A Manifest V3 worker can be suspended while a browser-owned Meet upload
   * is in flight. The meeting and raw chunks are durable, so drain both
   * interrupted processing records and recoverable managed errors after the
   * worker restores a signed-in mode. Local-BYOK records are never included.
   */
  private readonly meetFinishRuns = new Map<string, Promise<void>>();

  private async drainManagedMeetOutbox(): Promise<void> {
    if (this.managedMeetDrain) return this.managedMeetDrain;
    const settings = this.settings;
    if (!settings || settings.processingMode.kind !== "managed" || !settings.managedService) return;
    const drain = (async () => {
      const meetings = await listMeetings();
      for (const meeting of meetings) {
        if (
          meeting.captureSource !== "meet" ||
          (meeting.status !== "processing" && meeting.status !== "error") ||
          meeting.processingMode?.kind !== "managed" ||
          !managedMeetingMatchesService(meeting, settings.managedService) ||
          meeting.managedProcessing?.status === "complete"
        ) continue;
        await this.finishBrowserMeetRecording(meeting.id, meeting);
      }
    })();
    this.managedMeetDrain = drain;
    try {
      await drain;
    } finally {
      if (this.managedMeetDrain === drain) this.managedMeetDrain = null;
    }
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
      processingMode: this.settings.processingMode,
      managedService: this.settings.managedService,
      defaultMeetingMode: this.settings.defaultMeetingMode,
      customVocabulary: this.settings.customVocabulary,
      customSummaryInstructions: this.settings.customSummaryInstructions,
    });
  }

  async saveSettings(settings: NotetakerSettings): Promise<void> {
    // Persist before adopting: if the write fails, memory must not run ahead of disk
    // (the helper would record with settings that vanish on the next worker restart).
    await saveSettings(settings);
    this.settings = settings;
    this.pushCurrentSettings();
    // Open widgets learn about a toggled setting from here; the content script
    // has no storage access to watch it itself.
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId: "" });
    void flushWebappSyncOutbox(this.settings, this.fetchImpl);
    if (settings.processingMode.kind === "managed" && settings.managedService) {
      void this.drainManagedMeetOutbox().catch((error) => {
        console.warn("Managed Meet outbox could not be drained", error);
      });
    }
  }

  async startRecording(
    meetingMode: MeetingMode = this.settings?.defaultMeetingMode ?? "general",
    captureSource: CaptureSource = "desktop",
    titleHint?: string,
  ): Promise<string> {
    if (this.activeMeetingId) return this.activeMeetingId;
    // activeMeetingId is only assigned after an await (the calendar lookup),
    // so the guard above cannot catch a second START_RECORDING that arrives
    // while the first is still in that gap — a double-click, or the popup
    // and a keyboard shortcut firing together. Both would reach the helper
    // with different meeting ids and capture the same call twice. Claim the
    // slot synchronously instead.
    if (this.startInFlight) return this.startInFlight;
    const start = this.startRecordingUnguarded(meetingMode, captureSource, titleHint);
    this.startInFlight = start;
    try {
      return await start;
    } finally {
      if (this.startInFlight === start) this.startInFlight = null;
    }
  }

  private async startRecordingUnguarded(meetingMode: MeetingMode, captureSource: CaptureSource, titleHint?: string): Promise<string> {
    const needsHelper = captureSource !== "meet";
    let hostedQuotaWarning: Awaited<ReturnType<typeof getManagedEntitlements>> | null = null;
    if (needsHelper && (this.helperStatus !== "connected" || !this.helperInfo)) {
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId: null,
        phase: "start",
        message:
          this.helperStatus === "permission_required"
            ? "Chrome has not granted Native Messaging access. Open desktop helper setup, allow access, and check the helper again."
            : this.helperStatus === "incompatible"
            ? "The desktop helper needs an update before it can record. Open the install page to update it."
            : "The desktop helper is not connected. Install and start it, then check again.",
      });
      return "";
    }
    if (!this.settings?.consentDisclosureAcknowledged) {
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId: null,
        phase: "start",
        message: "Acknowledge the recording consent notice in setup before recording.",
      });
      return "";
    }
    if (this.settings.processingMode.kind === "managed") {
      const managed = this.settings.managedService;
      if (!managed) {
        this.broadcast({
          type: "RECORDING_ERROR",
          meetingId: null,
          phase: "start",
          message: "Hosted AI is not connected. Sign in again or switch to your own API keys in Settings before recording.",
          recovery: "sign_in",
        });
        return "";
      }
      try {
        const entitlements = await getManagedEntitlements(managed, this.fetchImpl);
        if (!entitlements.canProcess) {
          const message = entitlements.remaining <= 0
            ? "Hosted AI's meeting allowance is used up for this billing period. Open Hosted AI billing in Settings to choose a plan or resolve payment."
            : "Hosted AI is not active for this workspace. Open Hosted AI billing in Settings to choose a plan or resolve payment.";
          this.broadcast({ type: "RECORDING_ERROR", meetingId: null, phase: "start", message, recovery: "check_billing" });
          return "";
        }
        if (entitlements.warning === "low" || entitlements.audio.warning === "low") hostedQuotaWarning = entitlements;
      } catch (error) {
        // Only a rejected session needs a new sign-in; an offline or unavailable service is worth a plain retry.
        const sessionRejected = error instanceof ManagedAuthError;
        this.broadcast({
          type: "RECORDING_ERROR",
          meetingId: null,
          phase: "start",
          message: sessionRejected
            ? "Your hosted session has expired. Sign in again or switch to your own API keys in Settings before recording."
            : "Hosted AI could not be reached to check your plan. Check your connection and try again, or switch to your own API keys in Settings.",
          recovery: sessionRejected ? "sign_in" : "retry",
        });
        return "";
      }
    }
    if (captureSource === "meet" && this.settings.processingMode.kind === "local_byok") {
      // Meet audio is processed in the browser only after the call ends. Without keys the user would
      // record the whole meeting and learn at the end that nothing can turn it into notes.
      const missing = [this.settings.transcriptionProvider, this.settings.summarizationProvider].filter((provider) => !this.settings?.apiKeys[provider]?.trim());
      if (missing.length > 0) {
        this.broadcast({
          type: "RECORDING_ERROR",
          meetingId: null,
          phase: "start",
          message: `Add your ${missing.join(" and ")} API key in Settings before recording, or switch to Hosted AI.`,
          recovery: "check_provider_key",
        });
        return "";
      }
    }
    const meetingId = generateMeetingId();
    let title = titleHint?.trim().slice(0, 200) || `Meeting on ${new Date().toLocaleString()}`;
    let attendees: string[] | undefined;
    const localCalendar = this.settings?.calendar;
    if (localCalendar) {
      try {
        const event = await findCurrentEvent(localCalendar);
        if (event) {
          if (event.title) title = event.title;
          if (event.attendees.length > 0) attendees = event.attendees;
        }
      } catch {
        // Calendar enrichment is best-effort — never block a recording on it.
      }
    }
    const meeting: MeetingRecord = {
      id: meetingId,
      title,
      startedAt: new Date().toISOString(),
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: meetingMode,
      status: "recording",
      captureSource,
      processingMode: this.settings.processingMode,
      consentAcknowledged: true,
      ...(attendees ? { attendees } : {}),
    };
    await saveMeeting(meeting);
    if (captureSource === "meet") {
      await clearBrowserMeetChunks(meetingId).catch(() => undefined);
      this.meetChunkSequence.set(meetingId, 0);
    }
    this.activeMeetingId = meetingId;
    if (captureSource !== "meet") {
      try {
        this.client.startRecording(meetingId, meetingMode, captureSource, this.settings.processingMode, title);
      } catch {
        meeting.status = "error";
        meeting.errorMessage = "The desktop helper is not connected. Install and start it, then try again.";
        await saveMeeting(meeting);
        this.activeMeetingId = null;
        this.broadcast({ type: "RECORDING_ERROR", meetingId, message: meeting.errorMessage, phase: "start" });
        return meetingId;
      }
    }
    if (hostedQuotaWarning) notifyHostedQuotaLow(hostedQuotaWarning);
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
    return meetingId;
  }

  /** Flags "this moment" in an active recording; a no-op once the meeting is no longer recording. */
  async addBookmark(meetingId: string, note?: string): Promise<boolean> {
    if (this.activeMeetingId !== meetingId) return false;
    const updated = await updateMeeting(meetingId, (current) => (current.status === "recording" ? withBookmark(current, note) : current));
    if (!updated) return false;
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
    return true;
  }

  /** A non-fatal capture problem (one channel went quiet): tell every open view, keep recording. */
  warnRecording(meetingId: string, message: string): void {
    if (this.activeMeetingId !== meetingId) return;
    this.broadcast({ type: "PROCESSING_WARNING", meetingId, message });
  }

  async failRecording(meetingId: string, message: string): Promise<void> {
    try {
      const meeting = await getMeeting(meetingId);
      if (!meeting || meeting.captureSource !== "meet" || this.helperStatus === "connected") this.client.stopRecording(meetingId);
    } catch {
      // The local error is still durable if the helper has already gone away.
    }
    await updateMeeting(meetingId, (current) => ({ ...current, status: "error", errorMessage: message }));
    if (this.activeMeetingId === meetingId) this.activeMeetingId = null;
    this.broadcast({ type: "RECORDING_ERROR", meetingId, message });
  }

  /**
   * Tells whoever asked for a recording that it never began. Nothing was
   * created, so there is no meeting to fail and no reason for a toolbar badge.
   */
  reportStartFailure(message: string): void {
    this.broadcast({ type: "RECORDING_ERROR", meetingId: null, message, phase: "start" });
  }

  /** Expected first-use Chrome gate: show a brief, non-error instruction only on this Meet tab. */
  reportCaptureInvocationRequired(tabId: number): void {
    this.broadcast({ type: "CAPTURE_INVOCATION_REQUIRED", tabId });
  }

  /**
   * A start that got as far as creating the meeting but not as far as capturing
   * audio: forget the meeting entirely rather than leave a "Failed" entry with
   * no recording behind it.
   */
  async abortStart(meetingId: string, message: string, options: { silent?: boolean } = {}): Promise<void> {
    // A Meet start that reached meeting creation but never captured audio.
    // Worth reporting in hosted mode: repeated failures here are the top of
    // the "extension did nothing when I clicked start" funnel. Silent mode is
    // the auto-record watcher: the user never clicked, so nothing is surfaced.
    if (!options.silent) {
      reportManagedError(
        this.settings?.processingMode.kind === "managed" ? this.settings.managedService : null,
        new Error(message),
        { surface: "meet_capture", meetingId, key: `meet-start-abort:${message}` },
      );
    }
    try {
      if (this.helperStatus === "connected") this.client.discardRecording(meetingId);
    } catch {
      // The helper is optional for Meet; local cleanup below is what matters.
    }
    await clearBrowserMeetChunks(meetingId).catch(() => undefined);
    this.meetChunkSequence.delete(meetingId);
    await deleteLocalMeeting(meetingId);
    if (this.activeMeetingId === meetingId) this.activeMeetingId = null;
    if (!options.silent) this.reportStartFailure(message);
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
  }

  sendMeetAudioChunk(meetingId: string, channel: BrowserAudioChannel, pcm16: Uint8Array, sampleRateHz = 48_000, chunkId?: string): Promise<void> {
    if (sampleRateHz !== 48_000 || pcm16.byteLength === 0 || pcm16.byteLength > 64 * 1024 || pcm16.byteLength % 2 !== 0) {
      throw new Error("Meet audio chunks must be non-empty, even-length PCM16 data under 64 KiB at 48 kHz");
    }
    const previous = this.meetChunkWrites.get(meetingId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // Assigned inside the per-meeting write chain, so the order is the arrival order. After a worker
        // restart nothing is cached: continue from what IndexedDB already holds rather than restarting
        // at 0, which would collide with (or sort before) the chunks of the first half of the call.
        const next = this.meetChunkSequence.get(meetingId) ?? (await lastBrowserMeetSequence(meetingId)) + 1;
        this.meetChunkSequence.set(meetingId, next + 1);
        return appendBrowserMeetChunk(meetingId, channel, next, pcm16, Date.now(), chunkId);
      });
    this.meetChunkWrites.set(meetingId, current);
    const cleanup = () => {
      if (this.meetChunkWrites.get(meetingId) === current) this.meetChunkWrites.delete(meetingId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  async stopRecording(meetingId: string): Promise<void> {
    const existing = await getMeeting(meetingId);
    // A late or duplicate stop (stale popup, tab-close race) must not reopen a finished meeting for reprocessing.
    if (existing && existing.status !== "recording") return;
    // Through the per-meeting queue, so a live-transcript or bookmark write in flight is not overwritten.
    const meeting = existing
      ? await updateMeeting(meetingId, (current) => ({ ...current, status: "processing", endedAt: current.endedAt ?? new Date().toISOString() }))
      : null;
    if (this.activeMeetingId === meetingId) this.activeMeetingId = null;
    if (meeting?.captureSource === "meet") {
      // Writing the notes can take a minute; let every open view move on from
      // "recording" now instead of when the summary lands.
      this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
      await this.finishBrowserMeetRecording(meetingId, meeting);
      return;
    }
    try {
      const flagged = meeting ? flaggedMomentsFor(meeting) : [];
      if (flagged.length > 0) this.client.stopRecording(meetingId, flagged);
      else this.client.stopRecording(meetingId);
    } catch {
      // The helper may disappear between the UI click and the native send.
      // Keep the durable meeting record visible, but make the uncertain
      // finalization explicit instead of leaving the popup in a fake live
      // recording state or surfacing an unhandled promise rejection.
      reportManagedError(
        this.settings?.processingMode.kind === "managed" ? this.settings.managedService : null,
        new Error("stop command could not reach the desktop helper"),
        { surface: "background", meetingId, key: `stop-unreachable:${meetingId}` },
      );
      await updateMeeting(meetingId, (current) => ({
        ...current,
        status: "error",
        errorMessage: "The stop command could not reach the desktop helper. Reconnect it and recover this recording.",
      }));
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId,
        message: "The stop command could not reach the desktop helper. Reconnect it and recover this recording.",
      });
      return;
    }
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
  }

  /** Reprocesses raw extension-owned Meet audio after a BYOK or hosted error. */
  async retryProcessing(meetingId: string): Promise<void> {
    const meeting = await getMeeting(meetingId);
    if (!meeting || meeting.captureSource !== "meet") throw new Error("Only a saved Google Meet recording can be retried here.");
    if (meeting.status !== "error") throw new Error("This meeting is not waiting for a processing retry.");
    const processing = await updateMeeting(meetingId, (current) => ({ ...current, status: "processing", errorMessage: undefined }));
    if (!processing) throw new Error("Meeting could not be loaded for retry.");
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
    await this.finishBrowserMeetRecording(meetingId, processing);
  }

  /**
   * One processing run per meeting at a time. Stop, retry, and the managed
   * outbox drain can all arrive together (a settings save mid-processing
   * re-runs the drain); a second concurrent run would upload and bill twice.
   */
  private finishBrowserMeetRecording(meetingId: string, meeting: MeetingRecord): Promise<void> {
    const running = this.meetFinishRuns.get(meetingId);
    if (running) return running;
    const run = this.runBrowserMeetFinish(meetingId, meeting).finally(() => {
      if (this.meetFinishRuns.get(meetingId) === run) this.meetFinishRuns.delete(meetingId);
    });
    this.meetFinishRuns.set(meetingId, run);
    return run;
  }

  private async runBrowserMeetFinish(meetingId: string, meeting: MeetingRecord): Promise<void> {
    const pending = this.meetChunkWrites.get(meetingId);
    if (pending) await pending.catch(() => undefined);
    let jobAccepted = false;
    try {
      if (!this.settings) throw new Error("Meet settings are not loaded");
      // The mode is part of the recording's durable identity. Settings may
      // change while a call is in progress or before a retry; never let that
      // silently change where the saved audio is sent.
      const processingMode = meeting.processingMode ?? { kind: "local_byok" as const };
      if (processingMode.kind === "managed") {
        const managed = this.settings.processingMode.kind === "managed" ? this.settings.managedService : null;
        if (!managed) {
          throw new Error("This recording was started with Hosted AI. Switch back to its Hosted AI account to process it; saved audio is not uploaded in another mode.");
        }
        if (!managedMeetingMatchesService(meeting, managed)) {
          throw new Error("This Meet recording belongs to a different hosted workspace. Sign in to that workspace before retrying.");
        }
        // Stream the chunks: materializing every raw chunk in the worker at
        // once (an hour of two-channel 48 kHz PCM16 is ~700 MB per
        // browserStorage's own sizing note) is a heap exhaustion mid-upload.
        // Pack frames into bounded channel chunks to avoid one HTTP request,
        // object and database row per AudioWorklet frame.
        // A retry or worker restart after a completed upload must poll the job the server
        // already has, never upload the whole recording (and bill it) a second time.
        let upload: { uploadId: string; jobId: string };
        const existing = meeting.managedProcessing;
        if (existing?.uploadId && existing.jobId && existing.status !== "error") {
          upload = { uploadId: existing.uploadId, jobId: existing.jobId };
          jobAccepted = true;
        } else {
          const source = await managedAudioChunkSource(() => streamBrowserMeetChunks(meetingId));
          const endedAt = new Date().toISOString();
          await registerManagedMeeting(managed, meeting, endedAt, this.fetchImpl);
          upload = await uploadManagedMeeting(
            managed,
            meetingId,
            source,
            this.fetchImpl,
          );
          await updateMeeting(meetingId, (current) => ({
            ...current,
            status: "processing",
            managedProcessing: { uploadId: upload.uploadId, jobId: upload.jobId, status: "queued" },
          }));
          jobAccepted = true;
        }
        for (let attempt = 0; attempt < MANAGED_JOB_POLL_ATTEMPTS; attempt += 1) {
          const job = await getManagedJob(managed, upload.jobId, this.fetchImpl);
          if (job.status === "complete") {
            const completed = await updateMeeting(meetingId, (current) => ({
              ...current,
              status: "complete",
              summary: job.summary ?? "",
              actionItems: job.actionItems ?? [],
              endedAt: current.endedAt ?? new Date().toISOString(),
              managedProcessing: { uploadId: upload.uploadId, jobId: upload.jobId, status: "complete" },
            }));
            if (completed) {
              this.broadcast({ type: "SUMMARY_READY", meetingId, summary: completed.summary ?? "", actionItems: completed.actionItems });
              await this.syncToWebapp(completed);
              void this.exportToDrive(completed);
              await this.onNotesComplete(meetingId, completed);
            }
            await this.clearCompletedMeetChunks(meetingId);
            return;
          }
          if (job.status === "error") throw new HostedJobFailedError(job.message ?? "Hosted processing failed");
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        throw new Error("Hosted processing is taking longer than expected. It keeps running on the server; retry from the meeting details to check again.");
      }
      const localSettings: NotetakerSettings = {
        ...this.settings,
        processingMode: { kind: "local_byok" },
        managedService: null,
      };
      const result = await processBrowserMeetRecording(localSettings, meeting.mode ?? "general", streamBrowserMeetChunks(meetingId), this.fetchImpl, {
        startedAt: meeting.startedAt,
        segmentCache: { get: (key) => getTranscriptionSegment(meetingId, key), set: (key, lines) => saveTranscriptionSegment(meetingId, key, lines) },
      });
      const completed = await updateMeeting(meetingId, (current) => ({
        ...current,
        status: "complete",
        transcript: result.transcript,
        summary: result.summary,
        actionItems: result.actionItems,
        ...(result.title && /^Meeting on /.test(current.title) ? { title: result.title } : {}),
        endedAt: current.endedAt ?? new Date().toISOString(),
      }));
      if (completed) {
        this.broadcast({ type: "SUMMARY_READY", meetingId, summary: result.summary, actionItems: result.actionItems });
        await this.syncToWebapp(completed);
        void this.exportToDrive(completed);
        await this.onNotesComplete(meetingId, completed);
      }
      await this.clearCompletedMeetChunks(meetingId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Meet processing failed";
      if (meeting.processingMode?.kind === "managed" && isHostedQuotaExhaustion(message)) {
        notifyHostedQuotaExhausted();
      }
      // Hosted-mode critical failure: the user's recording produced no notes.
      // Report for diagnosis (no-op in local BYOK mode), then persist the
      // recoverable state exactly as before.
      const managedService = meeting.processingMode?.kind === "managed" &&
        this.settings?.processingMode.kind === "managed" &&
        managedMeetingMatchesService(meeting, this.settings.managedService)
        ? this.settings.managedService
        : null;
      reportManagedError(
        managedService,
        error,
        { surface: meeting.processingMode?.kind === "managed" ? "managed_job" : "meet_capture", meetingId },
      );
      await updateMeeting(meetingId, (current) => ({
        ...current,
        status: "error",
        errorMessage: `${message} Saved Meet audio is available for retry.`,
        ...(current.processingMode?.kind === "managed"
          ? {
              // Once the server accepted the upload, any failure other than the job itself failing
              // (timeout, network blip, expired session) leaves the job alive: keep it "processing" so
              // a retry polls it instead of uploading (and billing) the recording again.
              managedProcessing: {
                ...(current.managedProcessing ?? {}),
                status: jobAccepted && !(error instanceof HostedJobFailedError) ? ("processing" as const) : ("error" as const),
                errorMessage: message,
              },
            }
          : {}),
      }));
      this.broadcast({
        type: "RECORDING_ERROR",
        meetingId,
        message: `${message} Saved Meet audio is available for retry.`,
        ...(error instanceof ManagedAuthError ? { recovery: "sign_in" as const } : {}),
      });
    }
  }

  /**
   * Post-completion conveniences, run after the completed meeting is durable:
   * auto-share (creates an expiring attendee link when the setting is on and
   * a Hosted AI session exists) and open-notes (focus the notes tab instead
   * of only notifying). Both are best-effort — a failure here must never
   * demote a completed meeting.
   */
  private async onNotesComplete(meetingId: string, completed: MeetingRecord): Promise<void> {
    const canShareManagedMeeting = completed.processingMode?.kind === "managed" &&
      this.settings?.processingMode.kind === "managed" &&
      managedMeetingMatchesService(completed, this.settings.managedService);
    if (canShareManagedMeeting && this.settings?.autoShareNotesWithAttendees && !completed.attendeeShare) {
      const managed = this.settings.managedService;
      if (managed) {
        try {
          const share = await createManagedMeetingShare(managed, meetingId, this.fetchImpl);
          await updateMeeting(meetingId, (current) => ({
            ...current,
            attendeeShare: { shareUrl: share.shareUrl, expiresAt: share.expiresAt, createdAt: new Date().toISOString() },
          }));
        } catch (error) {
          reportManagedError(managed, error, { surface: "managed_job", meetingId, key: `auto-share:${meetingId}` });
        }
      }
    }
    if (this.settings?.openNotesWhenReady) {
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL(`meeting/meeting.html?id=${encodeURIComponent(meetingId)}`) });
      } catch {
        // The notification (already sent via SUMMARY_READY) remains the fallback.
      }
    }
  }

  /** Raw Meet chunks are disposable only after the completed meeting is
   * durable. A storage cleanup failure must not turn that completed meeting
   * into an error; the chunks remain available for an explicit cleanup/retry.
   */
  private async clearCompletedMeetChunks(meetingId: string): Promise<void> {
    try {
      await clearBrowserMeetChunks(meetingId);
    } catch (error) {
      console.warn("Completed Meet audio cleanup failed", { meetingId, error });
    } finally {
      await clearTranscriptionCache(meetingId).catch(() => undefined);
      this.meetChunkSequence.delete(meetingId);
    }
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
      await clearBrowserMeetChunks(meetingId).catch(() => undefined);
      this.meetChunkSequence.delete(meetingId);
      await deleteLocalMeeting(meetingId);
    }
  }

  async deleteMeeting(meetingId: string): Promise<void> {
    try {
      this.client.deleteMeeting(meetingId);
    } catch {
      // The helper may be offline; local deletion still needs to complete.
    } finally {
      // Remove both browser-owned Meet audio and the local meeting record even
      // when the desktop helper is temporarily unavailable.
      await clearBrowserMeetChunks(meetingId).catch(() => undefined);
      this.meetChunkSequence.delete(meetingId);
      await deleteLocalMeeting(meetingId);
    }
  }

  /**
   * Meet keys are used by this extension, so they are checked with a direct
   * provider call — as are desktop keys: they are pushed to the helper
   * verbatim with the settings, so the same check proves them to both
   * users, without making a missing helper block setup.
   */
  testProviderKey(provider: ProviderKind, key: string, options: { desktop?: boolean } = {}): Promise<{ valid: boolean; message: string }> {
    // `desktop` is ignored: every key the extension saves is also pushed
    // verbatim to the helper with the settings, so a direct check proves the
    // key to both users of it. The old helper-routed path made a missing
    // helper block desktop onboarding entirely (the user cannot finish
    // setup before the helper exists — that is the whole point of the flow).
    void options;
    return testProviderKeyDirect(provider, key, this.fetchImpl);
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

  /**
   * The widget must render immediately, so the calendar is never awaited here:
   * the last known title is returned and a stale one is refreshed in the
   * background, after which open widgets are told to look again.
   */
  private currentCallTitle(settings: NotetakerSettings): string | null {
    const localCalendar = settings.calendar;
    if (!localCalendar) return null;
    const stale = !this.currentEventCache || Date.now() - this.currentEventCache.at > 60_000;
    if (stale && !this.currentEventRefresh) {
      this.currentEventRefresh = (async () => {
        const event = await findCurrentEvent(localCalendar).catch(() => null);
        const title = event?.title?.trim() || null;
        const changed = this.currentEventCache?.title !== title;
        this.currentEventCache = { at: Date.now(), title };
        if (changed) this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId: "" });
      })().finally(() => {
        this.currentEventRefresh = null;
      });
    }
    return this.currentEventCache?.title ?? null;
  }

  async getWidgetState(): Promise<WidgetState> {
    const settings = this.settings ?? (await getSettings());
    const activeRecord = this.activeMeetingId ? await getMeeting(this.activeMeetingId) : null;
    const latestRecord = activeRecord ? null : ((await listMeetings(1))[0] ?? null);
    return {
      helperStatus: this.helperStatus,
      processingKind: settings.processingMode.kind,
      onboardingComplete: settings.onboardingComplete,
      consentAcknowledged: settings.consentDisclosureAcknowledged,
      widgetEnabled: settings.showMeetWidget !== false,
      shortcuts: await readShortcuts(),
      callTitle: this.currentCallTitle(settings),
      position: await getWidgetPosition(),
      defaultMeetingMode: settings.defaultMeetingMode,
      disclosureNoticeEnabled: settings.meetDisclosureNotice === true,
      active: activeRecord
        ? {
            id: activeRecord.id,
            title: activeRecord.title,
            startedAt: activeRecord.startedAt,
            status: activeRecord.status,
            ...(activeRecord.captureSource ? { captureSource: activeRecord.captureSource } : {}),
            ...(activeRecord.liveTranscriptStatus ? { liveTranscriptStatus: activeRecord.liveTranscriptStatus } : {}),
            ...(activeRecord.errorMessage ? { errorMessage: activeRecord.errorMessage } : {}),
            bookmarks: activeRecord.bookmarks ?? [],
            transcript: activeRecord.transcript.slice(-40).map(({ speaker, text, isFinal, utteranceId }) => ({
              speaker,
              text,
              isFinal,
              ...(utteranceId === undefined ? {} : { utteranceId }),
            })),
          }
        : null,
      latest: latestRecord
        ? {
            id: latestRecord.id,
            title: latestRecord.title,
            startedAt: latestRecord.startedAt,
            endedAt: latestRecord.endedAt,
            status: latestRecord.status,
            ...(latestRecord.errorMessage ? { errorMessage: latestRecord.errorMessage } : {}),
          }
        : null,
    };
  }

  private handleStatusChange(status: HelperConnectionStatus): void {
    this.helperStatus = status;
    if (status === "helper_not_found" || status === "disconnected" || status === "needs_pairing") this.helperInfo = null;
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
    this.helperStatus = msg.protocolVersion === 3 ? "connected" : "incompatible";
    this.broadcast({ type: "HELPER_STATUS", status: this.helperStatus });
  }

  private handleRecordingStarted(msg: Extract<IncomingMessage, { type: "recording_started" }>): void {
    this.activeMeetingId = msg.meetingId;
  }

  /**
   * The helper ended the capture on its own — not in reply to a Stop button
   * press here (that path finalizes via stopRecording). This arrives after
   * RESUME_RECORDING on a hosted-pending meeting (the helper completes the
   * stop it deferred earlier) and after any helper-initiated stop. Without
   * this, the meeting and every widget stayed "recording" forever while the
   * helper had already moved on; the notes-only aftermath (summary_ready /
   * managed_job_status) would then land on a meeting still showing live.
   * Finalize the durable state exactly like Stop does, minus the request
   * bookkeeping — the helper has already done its side.
   */
  private async handleRecordingStopped(msg: Extract<IncomingMessage, { type: "recording_stopped" }>): Promise<void> {
    const meetingId = msg.meetingId;
    const meeting = await getMeeting(meetingId);
    if (!meeting) return;
    // Only a live capture needs the transition; a meeting the user already
    // stopped (status processing/error/complete) must not be moved backward
    // into "processing" — that would erase an error the user should still see.
    if (meeting.status !== "recording") {
      // The helper says it stopped; do not keep presenting this meeting as the live one.
      if (this.activeMeetingId === meetingId) this.activeMeetingId = null;
      return;
    }
    await updateMeeting(meetingId, (current) =>
      current.status === "recording"
        ? { ...current, status: "processing", endedAt: current.endedAt ?? new Date().toISOString() }
        : current,
    );
    if (this.activeMeetingId === meetingId) this.activeMeetingId = null;
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
  }

  async updateMeetLiveTranscriptStatus(meetingId: string, status: LiveTranscriptStatus): Promise<void> {
    if (this.activeMeetingId !== meetingId) return;
    const meeting = await updateMeeting(meetingId, (current) =>
      current.status === "recording" ? { ...current, liveTranscriptStatus: status } : current,
    );
    if (!meeting || meeting.status !== "recording") return;
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId });
  }

  async addMeetLiveTranscript(update: {
    meetingId: string;
    channel: BrowserAudioChannel;
    speaker: import("../types").Speaker;
    text: string;
    isFinal: boolean;
    utteranceId: number;
    offsetMs: number;
  }): Promise<void> {
    if (this.activeMeetingId !== update.meetingId || !update.text.trim()) return;
    // Captions are already downstream of audio saved in IndexedDB. Paint them
    // immediately, then persist the extension's searchable meeting mirror;
    // a slow structured-clone/write must not make live captions feel laggy.
    this.broadcast({
      type: "TRANSCRIPT_UPDATE",
      meetingId: update.meetingId,
      speaker: update.speaker,
      text: update.text,
      isFinal: update.isFinal,
      utteranceId: update.utteranceId,
    });
    const meeting = await updateMeeting(update.meetingId, (current) => {
      if (current.status !== "recording") return current;
      const existingIndex = current.transcript.findIndex(
        (segment) => segment.speaker === update.speaker && segment.utteranceId === update.utteranceId && !segment.isFinal,
      );
      const segment: TranscriptSegment = {
        speaker: update.speaker,
        text: update.text,
        isFinal: update.isFinal,
        utteranceId: update.utteranceId,
        timestamp: new Date().toISOString(),
        offsetMs: update.offsetMs,
      };
      if (existingIndex >= 0) current.transcript[existingIndex] = segment;
      else current.transcript.push(segment);
      return current;
    });
    if (!meeting || meeting.status !== "recording") return;
  }

  private async handleTranscriptPartial(
    msg: Extract<IncomingMessage, { type: "transcript_partial" }>,
  ): Promise<void> {
    // The helper emits this only after it has processed durable raw audio.
    // Let open popup/widget views paint now while the local mirror write runs.
    this.broadcast({
      type: "TRANSCRIPT_UPDATE",
      meetingId: msg.meetingId,
      speaker: msg.speaker,
      text: msg.text,
      isFinal: msg.isFinal,
      utteranceId: msg.utteranceId,
    });
    const meeting = await updateMeeting(msg.meetingId, (current) => {
      const existingIndex = current.transcript.findIndex(
        (segment) => segment.speaker === msg.speaker && segment.utteranceId === msg.utteranceId && !segment.isFinal,
      );
      const updated: TranscriptSegment = {
        speaker: msg.speaker,
        text: msg.text,
        isFinal: msg.isFinal,
        utteranceId: msg.utteranceId,
        timestamp: new Date().toISOString(),
      };
      if (existingIndex >= 0) {
        current.transcript[existingIndex] = updated;
      } else {
        current.transcript.push(updated);
      }
      return current;
    });
    if (!meeting) return;
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
    void this.exportToDrive(meeting);
    await this.onNotesComplete(msg.meetingId, meeting);
    if (meeting.captureSource === "meet") {
      void clearBrowserMeetChunks(meeting.id)
        .catch(() => undefined)
        .finally(() => this.meetChunkSequence.delete(meeting.id));
    }
  }

  private async handleManagedJobStatus(msg: Extract<IncomingMessage, { type: "managed_job_status" }>): Promise<void> {
    const meeting = await updateMeeting(msg.meetingId, (current) => ({
      ...current,
      status: msg.status === "error" ? "error" : msg.status === "complete" ? "complete" : "processing",
      ...(msg.status === "complete" && msg.summary !== undefined ? { summary: msg.summary, actionItems: msg.actionItems ?? [], endedAt: new Date().toISOString() } : {}),
      ...(msg.status === "error" && msg.message ? { errorMessage: msg.message } : {}),
      managedProcessing: {
        jobId: msg.jobId || undefined,
        status: msg.status,
        ...(msg.message ? { errorMessage: msg.message } : {}),
      },
    }));
    if (!meeting) return;
    if (msg.status === "error" && meeting.processingMode?.kind === "managed" && isHostedQuotaExhaustion(msg.message ?? "")) {
      notifyHostedQuotaExhausted();
    }
    if (msg.status !== "error" && this.activeMeetingId === msg.meetingId) this.activeMeetingId = null;
    this.broadcast({ type: "MEETING_STATE_CHANGED", meetingId: msg.meetingId });
    if (msg.status === "complete" && msg.summary !== undefined) {
      this.broadcast({ type: "SUMMARY_READY", meetingId: msg.meetingId, summary: msg.summary, actionItems: msg.actionItems ?? [] });
      void this.syncToWebapp(meeting);
      void this.exportToDrive(meeting);
      void this.onNotesComplete(msg.meetingId, meeting);
      if (meeting.captureSource === "meet") {
        void clearBrowserMeetChunks(meeting.id)
          .catch(() => undefined)
          .finally(() => this.meetChunkSequence.delete(meeting.id));
      }
    }
  }

  private async exportToDrive(meeting: MeetingRecord): Promise<void> {
    const managedGoogle = this.settings?.processingMode.kind === "managed" ? this.settings.managedService : null;
    const connection = this.settings?.drive;
    if (!managedGoogle && !connection) return;
    try {
      await updateMeeting(meeting.id, (current) => ({
        ...current,
        driveExport: { status: "pending" },
      }));
      this.broadcast({ type: "DRIVE_EXPORT", meetingId: meeting.id, status: "pending" });
      const tokenBefore = connection?.accessToken;
      const result = managedGoogle
        ? await exportManagedMeetingToGoogleDrive(managedGoogle, meeting.id, this.fetchImpl)
        : await exportMeetingToDrive(meeting, connection!, this.fetchImpl);
      // A refresh mutates the connection in memory; keep the new token so the next export (or
      // a worker restart) does not start from an expired one.
      if (connection && this.settings && connection.accessToken !== tokenBefore) {
        await saveSettings(this.settings).catch(() => undefined);
      }
      await updateMeeting(meeting.id, (current) => ({
        ...current,
        driveExport: {
          status: "exported",
          fileId: result.fileId,
          ...(result.webViewLink ? { webViewLink: result.webViewLink } : {}),
          exportedAt: new Date().toISOString(),
        },
      }));
      this.broadcast({
        type: "DRIVE_EXPORT",
        meetingId: meeting.id,
        status: "exported",
        ...(result.webViewLink ? { webViewLink: result.webViewLink } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Drive export failed";
      await updateMeeting(meeting.id, (current) => ({
        ...current,
        driveExport: { status: "error", errorMessage: message },
      }));
      this.broadcast({ type: "DRIVE_EXPORT", meetingId: meeting.id, status: "error", message });
    }
  }

  async retryDriveExport(meetingId: string): Promise<void> {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return;
    const managedGoogle = this.settings?.processingMode.kind === "managed" ? this.settings.managedService : null;
    if (!managedGoogle && !this.settings?.drive) {
      this.broadcast({
        type: "DRIVE_EXPORT",
        meetingId,
        status: "error",
        message: "Connect Google Drive in your account before retrying the export.",
      });
      return;
    }
    await this.exportToDrive(meeting);
  }

  private async handleError(msg: Extract<IncomingMessage, { type: "error" }>): Promise<void> {
    const recovery = msg.recovery ?? errorRecoveryCategory(msg.code);
    if (msg.meetingId) {
      const meeting = await getMeeting(msg.meetingId);
      if (meeting) {
        // A failed transcription chunk is already durable and queued by the
        // helper. It is not a failed meeting: keep the recording active so a
        // later retry can append the recovered transcript and the user can
        // still stop normally.
        //
        // These prefixes are produced by the helper's pipeline (a separate
        // package, so they cannot be a shared constant). The Rust side pins
        // them in `retryable_errors_keep_the_wording_the_extension_matches_on`
        // — change a string here and you must change it there too, or a
        // retryable warning starts reading as a dead meeting.
        // A channel that went quiet (device unplugged, source ended) is a warning: the helper keeps
        // recording and re-attaches when it can, so the meeting stays live and stoppable.
        if (msg.code === "capture_lost" || RETRYABLE_HELPER_ERROR_PREFIXES.some((prefix) => msg.message.startsWith(prefix))) {
          this.broadcast({ type: "PROCESSING_WARNING", meetingId: msg.meetingId, message: msg.message, recovery });
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
    this.broadcast({ type: "RECORDING_ERROR", meetingId: msg.meetingId, message: msg.message, recovery });
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
