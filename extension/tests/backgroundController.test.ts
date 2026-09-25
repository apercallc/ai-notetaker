import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { BackgroundController, type NativeClientLike } from "../src/lib/backgroundController";
import { getMeeting, saveSettings, saveWidgetPosition } from "../src/lib/storage";
import { DEFAULT_SETTINGS } from "../src/types";
import * as browserStorage from "../src/meet/browserStorage";
import * as browserProcessing from "../src/meet/browserProcessing";
import * as managedClient from "../src/lib/managedClient";

vi.mock("../src/lib/calendar", () => ({ findCurrentEvent: vi.fn() }));
import { findCurrentEvent } from "../src/lib/calendar";
import { exportMeetingToDrive } from "../src/lib/drive";

vi.mock("../src/lib/drive", () => ({ exportMeetingToDrive: vi.fn() }));

function createFakeClient(): NativeClientLike & {
  emit: (type: string, payload: Record<string, unknown>) => void;
  emitStatus: (status: string) => void;
} {
  const handlers = new Map<string, Array<(msg: unknown) => void>>();
  return {
    connect: vi.fn(async () => {
      for (const handler of handlers.get("helper_info") ?? []) {
        handler({ type: "helper_info", helperVersion: "0.1.0", protocolVersion: 3, platform: "linux" });
      }
    }),
    on: vi.fn((type: string, handler: (msg: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    }),
    pushSettings: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    resumeRecording: vi.fn(),
    discardRecording: vi.fn(),
    deleteMeeting: vi.fn(),
    getAudioPreflight: vi.fn(async () => ({
      platform: "test",
      driver: "test",
      driverInstalled: true,
      microphone: "test microphone",
      speaker: "test speaker",
      ready: true,
      guidance: "ready",
      nativeLoopback: false,
      virtualDeviceFallback: true,
      permissionRequired: false,
    })),
    runAudioProbe: vi.fn(async () => ({ micFrames: 1, speakerFrames: 1, passed: true, message: "ok" })),
    testProviderKey: vi.fn(async () => ({ valid: true, message: "ok" })),
    onStatusChange: vi.fn((handler: (status: string) => void) => {
      if (!handlers.has("__status__")) handlers.set("__status__", []);
      handlers.get("__status__")!.push(handler as (msg: unknown) => void);
    }),
    emitStatus(status: string) {
      for (const handler of handlers.get("__status__") ?? []) handler(status);
    },
    emit(type, payload) {
      for (const handler of handlers.get(type) ?? []) handler({ type, ...payload });
    },
  };
}

beforeEach(async () => {
  chromeMock.reset();
  vi.restoreAllMocks();
  await saveSettings({ ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true });
});

describe("BackgroundController", () => {
  it("processes Meet locally with a connected helper, preserving call times and model notes", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    const chunks = (async function* () { yield { channel: "mic" as const, sequence: 0, bytes: new Uint8Array([1, 2]) }; })();
    vi.spyOn(browserStorage, "clearBrowserMeetChunks").mockResolvedValue();
    vi.spyOn(browserStorage, "streamBrowserMeetChunks").mockReturnValue(chunks);
    const process = vi.spyOn(browserProcessing, "processBrowserMeetRecording").mockResolvedValue({ transcript: [{ speaker: "you", text: "Hello", isFinal: true, timestamp: "2026-09-24T15:00:00Z", offsetMs: 123 }], summary: "Notes", title: "Planning", actionItems: [] });
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, apiKeys: { deepgram: "dg", claude: "cl" } });
    const id = await controller.startRecording("general", "meet");
    const original = await getMeeting(id);
    await controller.stopRecording(id);
    expect(client.startRecording).not.toHaveBeenCalled();
    expect(client.stopRecording).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledWith(expect.any(Object), "general", chunks, expect.any(Function), { startedAt: original?.startedAt });
    expect(await getMeeting(id)).toMatchObject({ status: "complete", title: "Planning", summary: "Notes", transcript: [expect.objectContaining({ offsetMs: 123 })], endedAt: expect.any(String) });
  });

  it("acknowledges a Meet chunk only after its durable write finishes", async () => {
    let finish!: () => void;
    vi.spyOn(browserStorage, "appendBrowserMeetChunk").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const controller = new BackgroundController(createFakeClient(), vi.fn());
    let acknowledged = false;
    const write = controller.sendMeetAudioChunk("durable", "mic", new Uint8Array([1, 2])).then(() => { acknowledged = true; });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(acknowledged).toBe(false);
    finish();
    await write;
    expect(acknowledged).toBe(true);
  });
  it("connects and pushes current settings on init", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();

    expect(client.connect).toHaveBeenCalled();
    expect(client.pushSettings).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptionProvider: DEFAULT_SETTINGS.transcriptionProvider }),
    );
  });

  it("creates a new meeting record and tells the helper to start recording", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();

    const meetingId = await controller.startRecording();

    expect(client.startRecording).toHaveBeenCalledWith(meetingId, "general", "desktop", { kind: "local_byok" }, expect.any(String));
    const stored = await getMeeting(meetingId);
    expect(stored?.status).toBe("recording");
  });

  it("pushes managed settings to the helper and preserves the mode on the meeting", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const managedSettings = {
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      processingMode: { kind: "managed", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" } as const,
      managedService: {
        baseUrl: "https://notes.example.com",
        accessToken: "session",
        accountId: "acct",
        workspaceId: "workspace",
        plan: "hosted_pro",
      },
    };

    await controller.saveSettings(managedSettings);
    controller.setFetchImpl(vi.fn(async () => new Response(JSON.stringify({ plan: "hosted_pro", status: "active", used: 0, limit: 1_000, remaining: 1_000, canProcess: true, inPaymentGrace: false }), { status: 200 })));
    expect(client.pushSettings).toHaveBeenLastCalledWith(expect.objectContaining({ processingMode: managedSettings.processingMode, managedService: managedSettings.managedService }));

    const meetingId = await controller.startRecording("general", "desktop");
    expect(client.startRecording).toHaveBeenLastCalledWith(meetingId, "general", "desktop", managedSettings.processingMode, expect.any(String));
    expect((await getMeeting(meetingId))?.processingMode).toEqual(managedSettings.processingMode);

    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, processingMode: { kind: "local_byok" }, managedService: null });
    expect(client.pushSettings).toHaveBeenLastCalledWith(expect.objectContaining({ processingMode: { kind: "local_byok" }, managedService: null }));
  });

  it("resumes a managed Meet processing record after the service worker restarts", async () => {
    const managedService = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" };
    const processingMode = { kind: "managed", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" } as const;
    await saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, processingMode, managedService });
    await (await import("../src/lib/storage")).saveMeeting({
      id: "pending-managed-meet",
      title: "Pending Meet",
      startedAt: "2026-09-24T15:00:00.000Z",
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: "general",
      status: "processing",
      captureSource: "meet",
      processingMode,
    });
    vi.spyOn(browserStorage, "listBrowserMeetChunks").mockResolvedValue([{ channel: "speaker", sequence: 0, bytes: new Uint8Array([1, 2]) }]);
    vi.spyOn(browserStorage, "clearBrowserMeetChunks").mockResolvedValue();
    vi.spyOn(managedClient, "registerManagedMeeting").mockResolvedValue();
    vi.spyOn(managedClient, "uploadManagedMeeting").mockResolvedValue({ uploadId: "upload-1", jobId: "job-1", meetingId: "pending-managed-meet" });
    vi.spyOn(managedClient, "getManagedJob").mockResolvedValue({ status: "complete", meetingId: "pending-managed-meet", summary: "Recovered summary", actionItems: [] });
    const controller = new BackgroundController(createFakeClient(), vi.fn());

    await controller.init();

    await vi.waitFor(async () => expect((await getMeeting("pending-managed-meet"))?.status).toBe("complete"));
    expect(managedClient.uploadManagedMeeting).toHaveBeenCalledWith(managedService, "pending-managed-meet", [{ channel: "speaker", index: 0, bytes: new Uint8Array([1, 2]) }], expect.any(Function));
  });

  it("drains an errored managed Meet after a fresh hosted sign-in", async () => {
    const managedService = { baseUrl: "https://notes.example.com", accessToken: "new-session", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" };
    const processingMode = { kind: "managed", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" } as const;
    await (await import("../src/lib/storage")).saveMeeting({
      id: "expired-session-meet",
      title: "Expired session Meet",
      startedAt: "2026-09-24T15:00:00.000Z",
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: "general",
      status: "error",
      errorMessage: "Managed service session expired. Saved Meet audio is available for retry.",
      captureSource: "meet",
      processingMode,
      managedProcessing: { uploadId: "upload-old", jobId: "job-old", status: "error", errorMessage: "session expired" },
    });
    vi.spyOn(browserStorage, "listBrowserMeetChunks").mockResolvedValue([{ channel: "speaker", sequence: 0, bytes: new Uint8Array([1, 2]) }]);
    vi.spyOn(browserStorage, "clearBrowserMeetChunks").mockResolvedValue();
    vi.spyOn(managedClient, "registerManagedMeeting").mockResolvedValue();
    vi.spyOn(managedClient, "uploadManagedMeeting").mockResolvedValue({ uploadId: "upload-new", jobId: "job-new", meetingId: "expired-session-meet" });
    vi.spyOn(managedClient, "getManagedJob").mockResolvedValue({ status: "complete", meetingId: "expired-session-meet", summary: "Recovered after sign-in", actionItems: [] });

    const controller = new BackgroundController(createFakeClient(), vi.fn());
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, processingMode, managedService });

    await vi.waitFor(async () => expect((await getMeeting("expired-session-meet"))?.status).toBe("complete"));
    expect(managedClient.uploadManagedMeeting).toHaveBeenCalledWith(managedService, "expired-session-meet", [{ channel: "speaker", index: 0, bytes: new Uint8Array([1, 2]) }], expect.any(Function));
  });

  it("does not replay a pending managed Meet into another workspace", async () => {
    const originalMode = { kind: "managed", accountId: "acct-old", workspaceId: "workspace-old", plan: "hosted_pro" } as const;
    await (await import("../src/lib/storage")).saveMeeting({
      id: "wrong-workspace-meet",
      title: "Wrong workspace Meet",
      startedAt: "2026-09-24T15:00:00.000Z",
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: "general",
      status: "error",
      errorMessage: "session expired",
      captureSource: "meet",
      processingMode: originalMode,
      managedProcessing: { status: "error", errorMessage: "session expired" },
    });
    const listChunks = vi.spyOn(browserStorage, "listBrowserMeetChunks");
    const upload = vi.spyOn(managedClient, "uploadManagedMeeting");
    const controller = new BackgroundController(createFakeClient(), vi.fn());
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      processingMode: { kind: "managed", accountId: "acct-new", workspaceId: "workspace-new", plan: "hosted_pro" },
      managedService: { baseUrl: "https://notes.example.com", accessToken: "new-session", accountId: "acct-new", workspaceId: "workspace-new", plan: "hosted_pro" },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listChunks).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await expect(getMeeting("wrong-workspace-meet")).resolves.toMatchObject({ status: "error" });
  });

  it("keeps a completed Meet when IndexedDB cleanup fails", async () => {
    await (await import("../src/lib/storage")).saveMeeting({
      id: "cleanup-failure-meet",
      title: "Cleanup failure Meet",
      startedAt: "2026-09-24T15:00:00.000Z",
      endedAt: null,
      transcript: [],
      summary: null,
      actionItems: [],
      mode: "general",
      status: "error",
      errorMessage: "temporary provider error",
      captureSource: "meet",
      processingMode: { kind: "local_byok" },
    });
    vi.spyOn(browserStorage, "listBrowserMeetChunks").mockResolvedValue([{ channel: "speaker", sequence: 0, bytes: new Uint8Array([1, 2]) }]);
    vi.spyOn(browserStorage, "clearBrowserMeetChunks").mockRejectedValue(new Error("IndexedDB unavailable"));
    vi.spyOn(browserProcessing, "processBrowserMeetRecording").mockResolvedValue({ transcript: [], summary: "Recovered", actionItems: [] });
    const controller = new BackgroundController(createFakeClient(), vi.fn());

    await controller.init();
    await controller.retryProcessing("cleanup-failure-meet");

    await expect(getMeeting("cleanup-failure-meet")).resolves.toMatchObject({ status: "complete", summary: "Recovered" });
  });

  it("blocks managed recording before creating a meeting when hosted quota is unavailable", async () => {
    const broadcast = vi.fn();
    const controller = new BackgroundController(createFakeClient(), broadcast);
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      processingMode: { kind: "managed", accountId: "acct", workspaceId: "workspace", plan: "local" },
      managedService: { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "workspace", plan: "local" },
    });
    controller.setFetchImpl(vi.fn(async () => new Response(JSON.stringify({ plan: "local", status: "inactive", used: 0, limit: 0, remaining: 0, canProcess: false, inPaymentGrace: false }), { status: 200 })));

    expect(await controller.startRecording("general", "meet")).toBe("");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "RECORDING_ERROR", recovery: "check_billing" }));
  });

  it("two overlapping start requests produce one recording, not two", async () => {
    // activeMeetingId is only assigned after the calendar lookup's await, so
    // a double-click (or the popup and a shortcut firing together) used to
    // slip two requests through the guard and capture the same call twice.
    let releaseCalendar: (() => void) | undefined;
    vi.mocked(findCurrentEvent).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCalendar = () => resolve(null);
        }),
    );
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      calendar: {
        provider: "google",
        clientId: "x",
        accessToken: "a",
        refreshToken: "r",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const first = controller.startRecording();
    const second = controller.startRecording();
    releaseCalendar?.();
    const [firstId, secondId] = await Promise.all([first, second]);

    expect(firstId).toBe(secondId);
    expect(client.startRecording).toHaveBeenCalledTimes(1);
  });

  it("titles the meeting from the matching calendar event when one is connected", async () => {
    vi.mocked(findCurrentEvent).mockResolvedValue({
      title: "Roadmap sync",
      attendees: ["Alex", "Sam"],
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(),
    });
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      calendar: {
        provider: "google",
        clientId: "x",
        accessToken: "a",
        refreshToken: "r",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const meetingId = await controller.startRecording();
    const meeting = await getMeeting(meetingId);

    expect(meeting?.title).toBe("Roadmap sync");
    expect(meeting?.attendees).toEqual(["Alex", "Sam"]);
  });

  it("falls back to the default title when no calendar is connected", async () => {
    vi.mocked(findCurrentEvent).mockResolvedValue(null);
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true });

    const meetingId = await controller.startRecording();
    const meeting = await getMeeting(meetingId);

    expect(meeting?.title).toContain("Meeting on");
    expect(meeting?.attendees).toBeUndefined();
  });

  it("falls back to the default title when the calendar lookup throws", async () => {
    vi.mocked(findCurrentEvent).mockRejectedValue(new Error("network error"));
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      calendar: {
        provider: "google",
        clientId: "x",
        accessToken: "a",
        refreshToken: "r",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const meetingId = await controller.startRecording();
    const meeting = await getMeeting(meetingId);
    expect(meeting?.title).toContain("Meeting on");
  });

  it("tracks a helper recording_started event for an existing meeting", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    client.emit("recording_started", { meetingId: "helper-meeting" });
    expect(controller.getState().activeMeeting).toEqual({ id: "helper-meeting" });
  });

  it("blocks recording until consent has been acknowledged", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    await saveSettings({ ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: false });
    const controller = new BackgroundController(client, broadcast);
    await controller.init();

    const meetingId = await controller.startRecording();

    expect(meetingId).toBe("");
    expect(client.startRecording).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({
      type: "RECORDING_ERROR",
      meetingId: null,
      phase: "start",
      message: "Acknowledge the recording consent notice in setup before recording.",
    });
  });

  it("uses the saved default meeting mode for new recordings", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, defaultMeetingMode: "standup", consentDisclosureAcknowledged: true });

    const meetingId = await controller.startRecording();

    expect(client.startRecording).toHaveBeenCalledWith(meetingId, "standup", "desktop", { kind: "local_byok" }, expect.any(String));
    expect((await getMeeting(meetingId))?.mode).toBe("standup");
  });

  it("does not leave a phantom recording when the helper send fails", async () => {
    const client = createFakeClient();
    vi.spyOn(client, "startRecording").mockImplementation(() => {
      throw new Error("not connected");
    });
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();

    const meetingId = await controller.startRecording();

    expect(controller.getState().activeMeeting).toBeNull();
    expect((await getMeeting(meetingId))?.status).toBe("error");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "RECORDING_ERROR", meetingId }));
  });

  it("appends transcript_partial segments to the active meeting and persists them", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "hello", isFinal: true });

    // Storage round-trips inside the handler resolve over several
    // microtask hops (the chrome.storage.local mock resolves via a Promise
    // executor, not synchronously) — a fixed number of `await
    // Promise.resolve()` calls is timing-dependent and flaky. vi.waitFor
    // polls the assertion instead of guessing the exact hop count.
    await vi.waitFor(() => {
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "TRANSCRIPT_UPDATE", meetingId, text: "hello" }),
      );
    });

    const stored = await getMeeting(meetingId);
    expect(stored?.transcript).toEqual([
      { speaker: "you", text: "hello", isFinal: true, timestamp: expect.any(String) },
    ]);
  });

  it("replaces an in-progress line in place instead of appending", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "hello wor", isFinal: false, utteranceId: 1 });
    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.transcript).toHaveLength(1);
    });

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "hello world", isFinal: true, utteranceId: 1 });
    await vi.waitFor(async () => {
      const meeting = await getMeeting(meetingId);
      expect(meeting?.transcript).toHaveLength(1);
      expect(meeting?.transcript[0]?.text).toBe("hello world");
      expect(meeting?.transcript[0]?.isFinal).toBe(true);
    });
  });

  it("starts a new row for a new utteranceId", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "first", isFinal: true, utteranceId: 1 });
    client.emit("transcript_partial", { meetingId, speaker: "you", text: "second", isFinal: true, utteranceId: 2 });

    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.transcript).toHaveLength(2);
    });
  });

  it("serializes concurrent transcript updates instead of dropping one", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "first", isFinal: true });
    client.emit("transcript_partial", { meetingId, speaker: "them", text: "second", isFinal: true });

    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.transcript).toHaveLength(2);
    });
  });

  it("marks the meeting complete and stores the summary on summary_ready", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("summary_ready", {
      meetingId,
      summary: "Talked about the roadmap.",
      actionItems: [{ text: "Follow up" }],
    });

    await vi.waitFor(() => {
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "SUMMARY_READY", meetingId }));
    });

    const stored = await getMeeting(meetingId);
    expect(stored?.status).toBe("complete");
    expect(stored?.summary).toBe("Talked about the roadmap.");
    expect(stored?.actionItems).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        text: "Follow up",
        status: "open",
        dueAt: null,
        completedAt: null,
      }),
    ]);
  });

  it("clears extension-owned Meet chunks when the helper completes managed processing", async () => {
    const managedService = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" };
    const processingMode = { kind: "managed", accountId: "acct", workspaceId: "workspace", plan: "hosted_pro" } as const;
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, processingMode, managedService });
    controller.setFetchImpl(vi.fn(async () => new Response(JSON.stringify({ plan: "hosted_pro", status: "active", used: 0, limit: 1_000, remaining: 1_000, canProcess: true, inPaymentGrace: false }), { status: 200 })));
    const clearChunks = vi.spyOn(browserStorage, "clearBrowserMeetChunks").mockResolvedValue();

    const meetingId = await controller.startRecording("general", "meet");
    client.emit("managed_job_status", { meetingId, jobId: "job-1", status: "complete", summary: "Managed summary", actionItems: [] });

    await vi.waitFor(async () => expect((await getMeeting(meetingId))?.status).toBe("complete"));
    expect(clearChunks).toHaveBeenCalledWith(meetingId);
  });

  it("keeps local completion successful when Drive export fails", async () => {
    vi.mocked(exportMeetingToDrive).mockRejectedValue(new Error("Drive request failed: 503"));
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      drive: { clientId: "client", accessToken: "token", expiresAt: Date.now() + 60_000 },
    });
    const meetingId = await controller.startRecording();

    client.emit("summary_ready", { meetingId, summary: "Saved locally", actionItems: [] });

    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.status).toBe("complete");
      expect((await getMeeting(meetingId))?.driveExport).toEqual(expect.objectContaining({ status: "error" }));
    });
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "DRIVE_EXPORT", status: "error", meetingId }));
  });

  it("exports a completed meeting asynchronously when Drive is connected", async () => {
    vi.mocked(exportMeetingToDrive).mockResolvedValue({ fileId: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" });
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    const drive = { clientId: "client", accessToken: "token", expiresAt: Date.now() + 60_000 };
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, drive });
    const meetingId = await controller.startRecording();
    client.emit("summary_ready", { meetingId, summary: "Saved to Drive", actionItems: [] });

    await vi.waitFor(async () => expect((await getMeeting(meetingId))?.driveExport?.status).toBe("exported"));
    expect(exportMeetingToDrive).toHaveBeenCalledWith(expect.objectContaining({ id: meetingId }), drive, expect.any(Function));
  });

  it("POSTs the finished meeting to the webapp when one is configured", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => ({ ok: true, status: 201 }) as Response);
    controller.setFetchImpl(fetchImpl);
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      consentDisclosureAcknowledged: true,
      webapp: { url: "https://notes.example.com", token: "tok123" },
    });
    const meetingId = await controller.startRecording();

    client.emit("summary_ready", { meetingId, summary: "s", actionItems: [] });

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalled();
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://notes.example.com/api/meetings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok123" }),
      }),
    );
  });

  it("syncs stable action metadata to the webapp", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => ({ ok: true, status: 201 }) as Response);
    controller.setFetchImpl(fetchImpl);
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, webapp: { url: "https://notes.example.com", token: "tok123" } });
    const meetingId = await controller.startRecording();

    client.emit("summary_ready", {
      meetingId,
      summary: "s",
      actionItems: [{ text: "Send proposal", owner: "you", id: "action-1", status: "open", dueAt: "2026-09-25T00:00:00.000Z" }],
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const request = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      mode: "general",
      actionItems: [{ id: expect.any(String), status: "open", dueAt: null }],
    });
  });

  it("does not call fetch at all when no webapp is configured", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    const fetchImpl = vi.fn();
    controller.setFetchImpl(fetchImpl);
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("summary_ready", { meetingId, summary: "s", actionItems: [] });

    // Wait for a positive signal that the full handler ran (the meeting
    // reaching "complete") before asserting the negative — otherwise this
    // could pass vacuously because the handler simply hasn't finished yet.
    await vi.waitFor(async () => {
      const meeting = await getMeeting(meetingId);
      expect(meeting?.status).toBe("complete");
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an invalid configured webapp URL while retaining the local meeting", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, webapp: { url: "https://notes.example.com/app", token: "tok" } });
    const meetingId = await controller.startRecording();
    client.emit("summary_ready", { meetingId, summary: "saved", actionItems: [] });
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "RECORDING_ERROR", meetingId })));
    expect((await getMeeting(meetingId))?.summary).toBe("saved");
  });

  it("marks the meeting as errored on an error message", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("error", { meetingId, code: "provider_auth_failed", message: "Key rejected" });

    await vi.waitFor(async () => {
      const meeting = await getMeeting(meetingId);
      expect(meeting?.status).toBe("error");
    });

    const stored = await getMeeting(meetingId);
    expect(stored?.errorMessage).toBe("Key rejected");
  });

  it("broadcasts helper errors for unknown meetings without creating phantom state", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    client.emit("error", { meetingId: "unknown", code: "provider_error", message: "failed" });
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith({ type: "RECORDING_ERROR", meetingId: "unknown", message: "failed", recovery: "retry" }));
    expect(await getMeeting("unknown")).toBeNull();
  });

  it("keeps the local meeting alive for each retryable processing warning", async () => {
    const warningMessages = [
      "transcript could not be persisted; queued for retry: disk busy",
      "summary deferred until transcription retries finish",
      "summarization failed: provider busy",
    ];
    for (const message of warningMessages) {
      const client = createFakeClient();
      const broadcast = vi.fn();
      const controller = new BackgroundController(client, broadcast);
      await controller.init();
      const meetingId = await controller.startRecording();
      client.emit("error", { meetingId, code: "temporary", message });
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith({ type: "PROCESSING_WARNING", meetingId, message, recovery: "retry" }));
      expect((await getMeeting(meetingId))?.status).toBe("recording");
    }
  });

  it("keeps the meeting active when a failed chunk is queued for retry", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("error", {
      meetingId,
      code: "provider_unreachable",
      message: "transcription failed, queued for retry: temporary outage",
    });

    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.status).toBe("recording");
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "PROCESSING_WARNING" }));
    });
    expect(controller.getState().activeMeeting).toEqual({ id: meetingId });
  });

  it("marks the meeting as processing and reflects no active meeting once stopped", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();
    expect(controller.getState().activeMeeting).toEqual({ id: meetingId });

    await controller.stopRecording(meetingId);

    expect(client.stopRecording).toHaveBeenCalledWith(meetingId);
    expect(controller.getState().activeMeeting).toBeNull();
    const stored = await getMeeting(meetingId);
    expect(stored?.status).toBe("processing");
  });

  it("shows a durable error instead of leaving a live view when the stop send fails", async () => {
    const client = createFakeClient();
    vi.spyOn(client, "stopRecording").mockImplementation(() => {
      throw new Error("disconnected");
    });
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    const meetingId = await controller.startRecording();

    await controller.stopRecording(meetingId);

    expect(controller.getState().activeMeeting).toBeNull();
    expect((await getMeeting(meetingId))?.status).toBe("error");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "RECORDING_ERROR", meetingId }));
  });

  it("clears the active meeting once its summary arrives", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();
    await controller.stopRecording(meetingId);

    client.emit("summary_ready", { meetingId, summary: "s", actionItems: [] });

    await vi.waitFor(() => {
      expect(controller.getState().activeMeeting).toBeNull();
    });
  });

  it("tracks a recovered_recording as recoverable state, and resuming clears it", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();

    client.emit("recovered_recording", { meetingId: "orphan-1", startedAt: "2026-09-21T09:00:00.000Z" });

    expect(controller.getState().recoverableMeeting).toEqual({
      meetingId: "orphan-1",
      startedAt: "2026-09-21T09:00:00.000Z",
    });

    controller.resumeRecording("orphan-1");
    expect(client.resumeRecording).toHaveBeenCalledWith("orphan-1");
    expect(controller.getState().recoverableMeeting).toBeNull();
  });

  it("discarding a recovered recording clears it without resuming", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    client.emit("recovered_recording", { meetingId: "orphan-2", startedAt: "2026-09-21T09:00:00.000Z" });

    await controller.discardRecording("orphan-2");

    expect(client.discardRecording).toHaveBeenCalledWith("orphan-2");
    expect(client.resumeRecording).not.toHaveBeenCalled();
    expect(controller.getState().recoverableMeeting).toBeNull();
  });

  it("deletes local meeting state and asks the helper to delete disk data", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    await controller.deleteMeeting(meetingId);

    expect(client.deleteMeeting).toHaveBeenCalledWith(meetingId);
    expect(await getMeeting(meetingId)).toBeNull();
  });

  it("tracks helper connection status and broadcasts it to the UI", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();

    client.emitStatus("helper_not_found");

    expect(controller.getState().helperStatus).toBe("helper_not_found");
    expect(broadcast).toHaveBeenCalledWith({ type: "HELPER_STATUS", status: "helper_not_found" });
  });

  it("does not create a local recording before the helper handshake completes", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);

    const meetingId = await controller.startRecording();

    expect(meetingId).toBe("");
    expect(client.startRecording).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({
      type: "RECORDING_ERROR",
      meetingId: null,
      phase: "start",
      message: "The desktop helper is not connected. Install and start it, then check again.",
    });
  });

  it("blocks recording when the helper advertises an incompatible protocol", async () => {
    const client = createFakeClient();
    const broadcast = vi.fn();
    const controller = new BackgroundController(client, broadcast);
    await controller.init();
    client.emit("helper_info", { helperVersion: "0.0.1", protocolVersion: 99, platform: "linux" });

    const meetingId = await controller.startRecording();

    expect(meetingId).toBe("");
    expect(client.startRecording).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "RECORDING_ERROR", meetingId: null }));
  });

  it("re-pushes settings when the helper (re)connects — the helper holds them in memory only", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    vi.mocked(client.pushSettings).mockClear();

    client.emitStatus("connected");

    // A restarted (or newly installed) helper process starts with no
    // settings; the transition to connected is when they come back.
    expect(client.pushSettings).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptionProvider: DEFAULT_SETTINGS.transcriptionProvider }),
    );
  });

  it("routes desktop key checks through the native messaging client", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());

    const result = await controller.testProviderKey("deepgram", "some-key", { desktop: true });

    expect(client.testProviderKey).toHaveBeenCalledWith("deepgram", "some-key");
    expect(result).toEqual({ valid: true, message: "ok" });
  });

  it("checks Meet-path keys directly from the extension, without the helper", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    const fetchImpl = vi.fn(async () => new Response("{\"access_token\":\"t\"}", { status: 200 }));
    controller.setFetchImpl(fetchImpl as unknown as typeof fetch);

    const result = await controller.testProviderKey("deepgram", "some-key");

    expect(client.testProviderKey).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("api.deepgram.com"), expect.anything());
    expect(result.valid).toBe(true);
  });
});

describe("BackgroundController: in-call widget support", () => {
  it("uses the tab-derived title hint when no calendar event names the call", async () => {
    vi.mocked(findCurrentEvent).mockResolvedValue(null);
    const controller = new BackgroundController(createFakeClient(), vi.fn());
    await controller.init();

    const meetingId = await controller.startRecording("general", "meet", "Google Meet abc-defg-hij");

    expect((await getMeeting(meetingId))?.title).toBe("Google Meet abc-defg-hij");
  });

  it("announces a started recording so open widgets can update", async () => {
    const broadcast = vi.fn();
    const controller = new BackgroundController(createFakeClient(), broadcast);
    await controller.init();

    const meetingId = await controller.startRecording();

    expect(broadcast).toHaveBeenCalledWith({ type: "MEETING_STATE_CHANGED", meetingId });
  });

  it("flags moments in the active recording as offsets from its start", async () => {
    const broadcast = vi.fn();
    const controller = new BackgroundController(createFakeClient(), broadcast);
    await controller.init();
    const meetingId = await controller.startRecording();

    expect(await controller.addBookmark(meetingId, "  decision on pricing ")).toBe(true);

    const stored = await getMeeting(meetingId);
    expect(stored?.bookmarks).toHaveLength(1);
    expect(stored?.bookmarks?.[0]).toMatchObject({ note: "decision on pricing" });
    expect(stored?.bookmarks?.[0]?.offsetMs).toBeGreaterThanOrEqual(0);
    expect(broadcast).toHaveBeenLastCalledWith({ type: "MEETING_STATE_CHANGED", meetingId });
  });

  it("hands the flagged moments to the helper when the recording stops, so the summary can weigh them", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();
    await controller.addBookmark(meetingId, "Pricing decision");
    await controller.addBookmark(meetingId);

    await controller.stopRecording(meetingId);

    expect(client.stopRecording).toHaveBeenCalledWith(meetingId, [
      expect.objectContaining({ offsetMs: expect.any(Number), note: "Pricing decision" }),
      expect.objectContaining({ offsetMs: expect.any(Number), note: "" }),
    ]);
  });

  it("stops exactly as before when nothing was flagged", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    await controller.stopRecording(meetingId);

    expect(client.stopRecording).toHaveBeenCalledWith(meetingId);
  });

  it("refuses to flag a moment for a meeting that is not the active recording", async () => {
    const controller = new BackgroundController(createFakeClient(), vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();
    await controller.stopRecording(meetingId);

    expect(await controller.addBookmark(meetingId, "too late")).toBe(false);
    expect(await controller.addBookmark("someone-else", "nope")).toBe(false);
    expect((await getMeeting(meetingId))?.bookmarks).toBeUndefined();
  });

  it("reports widget state for an idle helper with the latest meeting", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();
    await controller.stopRecording(meetingId);

    const state = await controller.getWidgetState();

    expect(state).toMatchObject({
      helperStatus: "connected",
      onboardingComplete: true,
      consentAcknowledged: true,
      widgetEnabled: true,
      active: null,
      latest: { id: meetingId, status: "processing" },
    });
  });

  it("reports widget state for an active recording with a bounded transcript and its bookmarks", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();
    for (let index = 0; index < 60; index += 1) {
      client.emit("transcript_partial", { meetingId, speaker: "you", text: `line ${index}`, isFinal: true, utteranceId: index });
    }
    await vi.waitFor(async () => expect((await getMeeting(meetingId))?.transcript).toHaveLength(60));
    await controller.addBookmark(meetingId, "key point");

    const state = await controller.getWidgetState();

    expect(state.latest).toBeNull();
    expect(state.active?.id).toBe(meetingId);
    expect(state.active?.transcript).toHaveLength(40);
    expect(state.active?.transcript.at(-1)?.text).toBe("line 59");
    expect(state.active?.bookmarks.map((bookmark) => bookmark.note)).toEqual(["key point"]);
  });

  it("tells open widgets when settings change, since they cannot watch storage themselves", async () => {
    const broadcast = vi.fn();
    const controller = new BackgroundController(createFakeClient(), broadcast);
    await controller.init();
    broadcast.mockClear();

    await controller.saveSettings({ ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true, showMeetWidget: false });

    expect(broadcast).toHaveBeenCalledWith({ type: "MEETING_STATE_CHANGED", meetingId: "" });
  });

  it("reports where the user left the widget", async () => {
    const controller = new BackgroundController(createFakeClient(), vi.fn());
    await controller.init();
    expect((await controller.getWidgetState()).position).toBeNull();
    await saveWidgetPosition({ x: 40, y: 50 });
    expect((await controller.getWidgetState()).position).toEqual({ x: 40, y: 50 });
  });

  it("lets the user turn the widget off from settings", async () => {
    const controller = new BackgroundController(createFakeClient(), vi.fn());
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, onboardingComplete: true, consentDisclosureAcknowledged: true, showMeetWidget: false });

    expect((await controller.getWidgetState()).widgetEnabled).toBe(false);
  });

  it("names the current call from the calendar without ever delaying the widget", async () => {
    vi.mocked(findCurrentEvent).mockClear();
    let release: (() => void) | undefined;
    vi.mocked(findCurrentEvent).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ title: "Weekly sync", attendees: [], startsAt: new Date().toISOString(), endsAt: new Date().toISOString() });
        }),
    );
    const broadcast = vi.fn();
    const controller = new BackgroundController(createFakeClient(), broadcast);
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
      consentDisclosureAcknowledged: true,
      calendar: { provider: "google", clientId: "x", accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    expect((await controller.getWidgetState()).callTitle).toBeNull();
    release?.();
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith({ type: "MEETING_STATE_CHANGED", meetingId: "" }));
    expect((await controller.getWidgetState()).callTitle).toBe("Weekly sync");
    expect(findCurrentEvent).toHaveBeenCalledTimes(1);
  });
});
