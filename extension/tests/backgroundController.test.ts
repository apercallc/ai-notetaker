import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { BackgroundController, type NativeClientLike } from "../src/lib/backgroundController";
import { getMeeting, saveSettings } from "../src/lib/storage";
import { DEFAULT_SETTINGS } from "../src/types";

function createFakeClient(): NativeClientLike & {
  emit: (type: string, payload: Record<string, unknown>) => void;
  emitStatus: (status: string) => void;
} {
  const handlers = new Map<string, Array<(msg: unknown) => void>>();
  return {
    connect: vi.fn(async () => {
      for (const handler of handlers.get("helper_info") ?? []) {
        handler({ type: "helper_info", helperVersion: "0.1.0", protocolVersion: 1, platform: "linux" });
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

    expect(client.startRecording).toHaveBeenCalledWith(meetingId, "general");
    const stored = await getMeeting(meetingId);
    expect(stored?.status).toBe("recording");
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
      message: "Acknowledge the recording consent notice in setup before recording.",
    });
  });

  it("uses the saved default meeting mode for new recordings", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    await controller.saveSettings({ ...DEFAULT_SETTINGS, defaultMeetingMode: "standup", consentDisclosureAcknowledged: true });

    const meetingId = await controller.startRecording();

    expect(client.startRecording).toHaveBeenCalledWith(meetingId, "standup");
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
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith({ type: "RECORDING_ERROR", meetingId: "unknown", message: "failed" }));
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
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith({ type: "PROCESSING_WARNING", meetingId, message }));
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

  it("delegates testProviderKey to the native messaging client rather than calling a provider directly", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());

    const result = await controller.testProviderKey("deepgram", "some-key");

    expect(client.testProviderKey).toHaveBeenCalledWith("deepgram", "some-key");
    expect(result).toEqual({ valid: true, message: "ok" });
  });
});
