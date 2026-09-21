import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { BackgroundController, type NativeClientLike } from "../src/lib/backgroundController";
import { getMeeting } from "../src/lib/storage";
import { DEFAULT_SETTINGS } from "../src/types";

function createFakeClient(): NativeClientLike & {
  emit: (type: string, payload: Record<string, unknown>) => void;
  emitStatus: (status: string) => void;
} {
  const handlers = new Map<string, Array<(msg: unknown) => void>>();
  return {
    connect: vi.fn(async () => {}),
    on: vi.fn((type: string, handler: (msg: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    }),
    pushSettings: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    resumeRecording: vi.fn(),
    discardRecording: vi.fn(),
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

beforeEach(() => {
  chromeMock.reset();
  vi.restoreAllMocks();
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

    expect(client.startRecording).toHaveBeenCalledWith(meetingId);
    const stored = await getMeeting(meetingId);
    expect(stored?.status).toBe("recording");
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
    expect(stored?.actionItems).toEqual([{ text: "Follow up" }]);
  });

  it("POSTs the finished meeting to the webapp when one is configured", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    controller.setFetchImpl(fetchImpl);
    await controller.init();
    await controller.saveSettings({
      ...DEFAULT_SETTINGS,
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
    const stored = await getMeeting(meetingId);
    expect(stored?.status).toBe("processing");
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

  it("discarding a recovered recording clears it without resuming", () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    client.emit("recovered_recording", { meetingId: "orphan-2", startedAt: "2026-09-21T09:00:00.000Z" });

    controller.discardRecording("orphan-2");

    expect(client.discardRecording).toHaveBeenCalledWith("orphan-2");
    expect(client.resumeRecording).not.toHaveBeenCalled();
    expect(controller.getState().recoverableMeeting).toBeNull();
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
