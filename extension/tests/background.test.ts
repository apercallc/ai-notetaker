import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";

const mocks = vi.hoisted(() => {
  const controller = {
    init: vi.fn(async () => {}),
    getState: vi.fn(() => ({ activeMeeting: null })),
    getWidgetState: vi.fn(),
    startRecording: vi.fn(),
    deleteMeeting: vi.fn(async () => {}),
    discardRecording: vi.fn(async () => {}),
    resumeRecording: vi.fn(),
    addBookmark: vi.fn(async () => true),
    failRecording: vi.fn(async () => {}),
  };
  const capture = {
    restoreCaptures: vi.fn(async () => {}),
    isActive: vi.fn(() => false),
    isActiveForTab: vi.fn(() => false),
    widgetTabId: vi.fn((): number | undefined => undefined),
    forwardChunk: vi.fn(),
    recover: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const session = {
    startMeetRecording: vi.fn(async () => "new-meeting"),
    stopMeetRecording: vi.fn(async () => {}),
    finishMeetCaptureForTab: vi.fn(async () => {}),
    handleMeetCommand: vi.fn(async () => {}),
  };
  return { controller, capture, session };
});

vi.mock("../src/lib/backgroundController", () => ({ BackgroundController: vi.fn(function () { return mocks.controller; }) }));
vi.mock("../src/meet/meetCapture", () => ({ MeetCaptureController: vi.fn(function () { return mocks.capture; }) }));
vi.mock("../src/meet/session", () => mocks.session);
vi.mock("../src/lib/nativeMessaging", () => ({ NativeMessagingClient: vi.fn(function () { return { retryFromAlarm: vi.fn() }; }) }));
vi.mock("../src/lib/storage", () => ({
  getSettings: vi.fn(async () => ({})),
  migrateSavedProcessingModeToApiKeys: vi.fn(async () => {}),
  saveWidgetPosition: vi.fn(async () => {}),
}));
vi.mock("../src/lib/reminderAlarm", () => ({ openReminderCall: vi.fn(), runMeetReminders: vi.fn(), syncReminderAlarm: vi.fn(async () => {}) }));
vi.mock("../src/meet/tabBroadcast", () => ({ broadcastToMeetTabs: vi.fn(async () => {}) }));
vi.mock("../src/meet/pendingStart", () => ({ clearPendingMeetStartFor: vi.fn(async () => {}) }));
vi.mock("../src/lib/recordingBadge", () => ({ setBadge: vi.fn() }));
vi.mock("../src/lib/notesReady", () => ({ notifyNotesReady: vi.fn(), openNotesReady: vi.fn() }));
vi.mock("../src/lib/hostedQuotaNotice", () => ({ openHostedQuotaNotice: vi.fn() }));
vi.mock("../src/lib/installHandler", () => ({ handleInstalled: vi.fn() }));
vi.mock("../src/lib/autoRecord", () => ({ maybeAutoStartMeetRecording: vi.fn(), clearAutoRecordAttempt: vi.fn() }));
vi.mock("../src/lib/managedClient", () => ({ getManagedEntitlements: vi.fn() }));

type Listener = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean;
const EXTENSION_ID = "fake-extension-id";
const contentScript = (tabId: number | undefined) => ({ id: EXTENSION_ID, url: "https://meet.google.com/abc-defg-hij", ...(tabId === undefined ? {} : { tab: { id: tabId } }) });
const popup = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` };

let listener: Listener;

async function load(): Promise<void> {
  vi.resetModules();
  chromeMock.reset();
  await import("../src/background");
  listener = chromeMock.runtime.onMessage.addListener.mock.calls[0]![0] as Listener;
}

function send(message: unknown, sender: unknown): Promise<{ handled: boolean; response?: unknown }> {
  return new Promise((resolve) => {
    const handled = listener(message, sender, (response) => resolve({ handled: true, response }));
    if (!handled) resolve({ handled: false });
  });
}

describe("background message handling", () => {
  beforeEach(async () => {
    for (const group of Object.values(mocks)) for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockClear();
    mocks.capture.isActiveForTab.mockReturnValue(false);
    mocks.capture.widgetTabId.mockReturnValue(undefined);
    mocks.controller.getState.mockReturnValue({ activeMeeting: null });
    await load();
  });

  it("restores captures before init and hands init a live-capture check", async () => {
    await vi.waitFor(() => expect(mocks.controller.init).toHaveBeenCalled());
    const options = mocks.controller.init.mock.calls[0] as unknown as [{ hasLiveCapture: (id: string) => boolean }];
    mocks.capture.isActive.mockReturnValueOnce(true);
    expect(options[0].hasLiveCapture("m1")).toBe(true);
    expect(mocks.capture.restoreCaptures.mock.invocationCallOrder[0]!).toBeLessThan(mocks.controller.init.mock.invocationCallOrder[0]!);
  });

  it("ignores messages from untrusted senders and from other extensions", async () => {
    expect((await send({ type: "GET_STATE" }, { id: "other", url: "chrome-extension://other/x.html" })).handled).toBe(false);
    expect((await send({ type: "GET_STATE" }, { id: EXTENSION_ID, url: "https://evil.example/", tab: { id: 1 } })).handled).toBe(false);
    expect((await send({ type: "GET_STATE" }, contentScript(undefined))).handled).toBe(false);
    expect((await send({ nope: true }, popup)).handled).toBe(false);
  });

  it("does not let a page-side content script use extension-page requests", async () => {
    for (const type of ["DELETE_MEETING", "DISCARD_RECORDING", "RESUME_RECORDING", "SAVE_SETTINGS", "MEET_AUDIO_CHUNK"]) {
      expect((await send({ type, meetingId: "m1" }, contentScript(5))).handled).toBe(false);
    }
    expect(mocks.controller.deleteMeeting).not.toHaveBeenCalled();
  });

  it("lets a content script stop only the recording running in its own tab", async () => {
    mocks.capture.isActiveForTab.mockImplementation(((id: string, tab: number) => id === "mine" && tab === 5) as never);
    expect((await send({ type: "STOP_RECORDING", meetingId: "theirs" }, contentScript(5))).response).toEqual({});
    expect((await send({ type: "STOP_RECORDING", meetingId: "mine" }, contentScript(6))).response).toEqual({});
    expect(mocks.session.stopMeetRecording).not.toHaveBeenCalled();

    await send({ type: "STOP_RECORDING", meetingId: "mine" }, contentScript(5));
    expect(mocks.session.stopMeetRecording).toHaveBeenCalledWith(mocks.controller, mocks.capture, "mine");
  });

  it("lets extension pages stop any recording and refuses content-script bookmarks for other tabs", async () => {
    await send({ type: "STOP_RECORDING", meetingId: "any" }, popup);
    expect(mocks.session.stopMeetRecording).toHaveBeenCalledWith(mocks.controller, mocks.capture, "any");
    expect((await send({ type: "ADD_BOOKMARK", meetingId: "any", note: "x" }, contentScript(5))).response).toEqual({ ok: false });
    expect(mocks.controller.addBookmark).not.toHaveBeenCalled();
  });

  it("starts recordings on the sender's own tab, ignoring a tab id the page names", async () => {
    await send({ type: "START_RECORDING", captureSource: "desktop", tabId: 99 }, contentScript(5));
    expect(mocks.session.startMeetRecording).toHaveBeenCalledWith(mocks.controller, mocks.capture, expect.objectContaining({ tabId: 5 }));
    mocks.session.startMeetRecording.mockClear();
    const refused = await send({ type: "START_RECORDING", captureSource: "desktop" }, popup);
    expect(refused.response).toEqual({ error: expect.stringContaining("desktop app") });
    expect(mocks.session.startMeetRecording).not.toHaveBeenCalled();
  });

  it("scrubs the widget state for a content script", async () => {
    const record = (id: string) => ({ id, title: "Secret", startedAt: "2026-10-01T10:00:00.000Z" });
    mocks.controller.getWidgetState.mockResolvedValue({ active: null, latest: record("other-tab-meeting"), callTitle: "Private call", recordingElsewhere: false });
    mocks.capture.widgetTabId.mockReturnValue(9);
    const scrubbed = (await send({ type: "GET_WIDGET_STATE" }, contentScript(5))).response as Record<string, unknown>;
    expect(scrubbed).toMatchObject({ latest: null, callTitle: null });

    mocks.capture.widgetTabId.mockReturnValue(5);
    mocks.controller.getWidgetState.mockResolvedValue({ active: null, latest: record("mine"), callTitle: "Private call", recordingElsewhere: false });
    const own = (await send({ type: "GET_WIDGET_STATE" }, contentScript(5))).response as Record<string, unknown>;
    expect(own).toMatchObject({ latest: { id: "mine" }, callTitle: null });

    mocks.controller.getWidgetState.mockResolvedValue({ active: record("live"), latest: record("mine"), callTitle: "Private call", recordingElsewhere: false });
    const elsewhere = (await send({ type: "GET_WIDGET_STATE" }, contentScript(5))).response;
    expect(elsewhere).toMatchObject({ active: null, latest: null, callTitle: null, recordingElsewhere: true });

    mocks.controller.getWidgetState.mockResolvedValue({ active: record("live"), latest: null, callTitle: "Private call", recordingElsewhere: false });
    const full = (await send({ type: "GET_WIDGET_STATE" }, popup)).response as Record<string, unknown>;
    expect(full).toMatchObject({ callTitle: "Private call", active: { id: "live" } });
  });

  it("answers a failing handler with an error envelope instead of hanging", async () => {
    mocks.controller.deleteMeeting.mockRejectedValueOnce(new Error("Stop the recording before deleting it."));
    expect((await send({ type: "DELETE_MEETING", meetingId: "live" }, popup)).response).toEqual({ error: "Stop the recording before deleting it." });
  });
});
