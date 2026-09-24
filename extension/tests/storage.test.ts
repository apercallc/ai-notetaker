import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock } from "./setup";
import {
  getSettings,
  saveSettings,
  getPairingToken,
  savePairingToken,
  clearPairingToken,
  listMeetings,
  saveMeeting,
  getMeeting,
  deleteMeeting,
  getWebappSyncOutbox,
  queueWebappSync,
  removeWebappSyncOutbox,
  getRemindedCalls,
  saveRemindedCalls,
  getWidgetPosition,
  saveWidgetPosition,
} from "../src/lib/storage";
import { DEFAULT_SETTINGS, type MeetingRecord } from "../src/types";

beforeEach(() => {
  chromeMock.reset();
});

describe("settings storage", () => {
  it("returns defaults when nothing has been saved yet", async () => {
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips saved settings", async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      transcriptionProvider: "groq",
      apiKeys: { groq: "test-key" },
    });
    const settings = await getSettings();
    expect(settings.transcriptionProvider).toBe("groq");
    expect(settings.apiKeys.groq).toBe("test-key");
  });

  it("backfills new meeting-intelligence settings for older installs", async () => {
    await chrome.storage.local.set({
      "notetaker.settings": {
        transcriptionProvider: "deepgram",
        summarizationProvider: "claude",
        apiKeys: { deepgram: "legacy-key" },
        webapp: null,
        onboardingComplete: true,
        consentDisclosureAcknowledged: true,
      },
    });

    const settings = await getSettings();
    expect(settings.defaultMeetingMode).toBe("general");
    expect(settings.customVocabulary).toEqual([]);
    expect(settings.customSummaryInstructions).toBe("");
    expect(settings.apiKeys.deepgram).toBe("legacy-key");
  });

  it("falls back to local BYOK when a stored managed workspace identity is incomplete", async () => {
    await chrome.storage.local.set({
      "notetaker.settings": {
        ...DEFAULT_SETTINGS,
        processingMode: { kind: "managed", accountId: "acct", workspaceId: "   ", plan: "hosted_pro" },
        managedService: {
          baseUrl: "https://notes.example.com",
          accessToken: "session",
          accountId: "acct",
          workspaceId: "   ",
          plan: "hosted_pro",
        },
      },
    });

    await expect(getSettings()).resolves.toMatchObject({ processingMode: { kind: "local_byok" } });
  });

  it("round-trips hosted mode separately from the local BYOK mode", async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      processingMode: { kind: "managed", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" },
      managedService: {
        baseUrl: "https://notes.example.com",
        accessToken: "session-token",
        accountId: "acct",
        workspaceId: "ws",
        plan: "hosted_pro",
      },
    });

    await expect(getSettings()).resolves.toMatchObject({
      processingMode: { kind: "managed", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" },
      managedService: { accessToken: "session-token", workspaceId: "ws" },
    });

    await saveSettings({ ...DEFAULT_SETTINGS, processingMode: { kind: "local_byok" }, managedService: null });
    await expect(getSettings()).resolves.toMatchObject({ processingMode: { kind: "local_byok" }, managedService: null });
  });

  it("never writes settings (or API keys) to chrome.storage.sync", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, apiKeys: { claude: "secret" } });
    expect(chromeMock.storage.sync.set).not.toHaveBeenCalled();
    expect(chromeMock.storage.local.set).toHaveBeenCalled();
  });

  it("surfaces chrome storage failures instead of silently losing settings", async () => {
    chromeMock.storage.local.set.mockImplementationOnce((_items, callback) => {
      chromeMock.runtime.lastError = { message: "storage quota exceeded" };
      callback?.();
      chromeMock.runtime.lastError = undefined;
    });
    await expect(saveSettings({ ...DEFAULT_SETTINGS })).rejects.toThrow("storage quota exceeded");
  });
});

describe("pairing token storage", () => {
  it("is null before pairing happens", async () => {
    expect(await getPairingToken()).toBeNull();
  });

  it("round-trips a saved pairing token", async () => {
    await savePairingToken("abc123");
    expect(await getPairingToken()).toBe("abc123");
  });

  it("clears only the local pairing token for profile recovery", async () => {
    await savePairingToken("stale-token");
    await clearPairingToken();

    expect(await getPairingToken()).toBeNull();
  });
});

describe("meeting storage", () => {
  const meeting: MeetingRecord = {
    id: "m1",
    title: "Standup",
    startedAt: "2026-09-21T10:00:00.000Z",
    endedAt: "2026-09-21T10:15:00.000Z",
    transcript: [],
    summary: "Discussed the roadmap.",
    actionItems: [{ text: "Follow up with design" }],
    status: "complete",
  };

  it("lists no meetings initially", async () => {
    expect(await listMeetings()).toEqual([]);
  });

  it("saves and retrieves a meeting by id", async () => {
    await saveMeeting(meeting);
    expect(await getMeeting("m1")).toEqual(meeting);
  });

  it("lists saved meetings newest-first", async () => {
    await saveMeeting({ ...meeting, id: "m1", startedAt: "2026-09-21T09:00:00.000Z" });
    await saveMeeting({ ...meeting, id: "m2", startedAt: "2026-09-21T10:00:00.000Z" });
    const meetings = await listMeetings();
    expect(meetings.map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("can list only the newest meetings without reading the whole archive", async () => {
    await saveMeeting({ ...meeting, id: "m1", startedAt: "2026-09-21T09:00:00.000Z" });
    await saveMeeting({ ...meeting, id: "m2", startedAt: "2026-09-21T10:00:00.000Z" });
    await saveMeeting({ ...meeting, id: "m3", startedAt: "2026-09-21T11:00:00.000Z" });

    expect((await listMeetings(2)).map((item) => item.id)).toEqual(["m3", "m2"]);
  });

  it("searches the complete archive across titles, summaries, transcripts, and actions", async () => {
    await saveMeeting({ ...meeting, id: "m1", summary: "Roadmap review" });
    await saveMeeting({
      ...meeting,
      id: "m2",
      title: "Customer call",
      summary: "Discussed launch timing",
      transcript: [{ speaker: "them", text: "The launch is Friday", timestamp: "2026-09-21T10:01:00.000Z", isFinal: true }],
      actionItems: [{ text: "Send the launch brief", owner: "Alex" }],
    });

    expect((await listMeetings(undefined, "launch")).map((item) => item.id)).toEqual(["m2"]);
    expect((await listMeetings(undefined, "design")).map((item) => item.id)).toEqual(["m1"]);
    expect((await listMeetings(undefined, "alex")).map((item) => item.id)).toEqual(["m2"]);
  });

  it("loads an archive search with one batched storage read", async () => {
    await saveMeeting({ ...meeting, id: "m1" });
    await saveMeeting({ ...meeting, id: "m2", title: "Customer call" });
    chromeMock.storage.local.get.mockClear();

    await listMeetings(undefined, "customer");

    expect(chromeMock.storage.local.get).toHaveBeenCalledTimes(2);
    expect(chromeMock.storage.local.get).toHaveBeenLastCalledWith(
      ["notetaker.meeting.m1", "notetaker.meeting.m2"],
      expect.any(Function),
    );
  });

  it("deletes a meeting", async () => {
    await saveMeeting(meeting);
    await queueWebappSync(meeting);
    await deleteMeeting("m1");
    expect(await getMeeting("m1")).toBeNull();
    expect(await listMeetings()).toEqual([]);
    expect(await getWebappSyncOutbox()).toEqual([]);
  });

  it("upserts rather than duplicating on repeated save", async () => {
    await saveMeeting(meeting);
    await saveMeeting({ ...meeting, summary: "Updated summary" });
    const meetings = await listMeetings();
    expect(meetings).toHaveLength(1);
    expect(meetings[0]?.summary).toBe("Updated summary");
  });

  it("persists a bounded webapp sync outbox and removes delivered meetings", async () => {
    await queueWebappSync(meeting);

    expect(await getWebappSyncOutbox()).toEqual([meeting]);
    await removeWebappSyncOutbox(meeting.id);
    expect(await getWebappSyncOutbox()).toEqual([]);
  });

  it("filters malformed entries restored from an older outbox", async () => {
    await chrome.storage.local.set({ "notetaker.webappSync.outbox": [null, { id: 3 }, meeting] });
    expect(await getWebappSyncOutbox()).toEqual([meeting]);
  });

  it("serializes concurrent webapp outbox updates without dropping a meeting", async () => {
    const second = { ...meeting, id: "m2", title: "Second meeting" };
    await Promise.all([queueWebappSync(meeting), queueWebappSync(second)]);

    expect((await getWebappSyncOutbox()).map((item) => item.id)).toEqual(["m1", "m2"]);
  });
});

describe("widget position and reminded calls", () => {
  it("remembers where the widget was dropped, rounded to whole pixels", async () => {
    expect(await getWidgetPosition()).toBeNull();
    await saveWidgetPosition({ x: 120.6, y: 88.2 });
    expect(await getWidgetPosition()).toEqual({ x: 121, y: 88 });
  });

  it("refuses positions a page-side sender should never be able to store", async () => {
    await saveWidgetPosition({ x: 10, y: 10 });
    for (const bad of [{ x: Number.NaN, y: 1 }, { x: 1e9, y: 1 }, { x: "1", y: 1 }, null] as unknown[]) {
      await saveWidgetPosition(bad as { x: number; y: number });
    }
    expect(await getWidgetPosition()).toEqual({ x: 10, y: 10 });
  });

  it("ignores a stored value that is not a position", async () => {
    chromeMock.storage.local._dump()["notetaker.widget.position"] = { x: "left", y: 5 };
    expect(await getWidgetPosition()).toBeNull();
  });

  it("round-trips reminded calls and treats a missing record as empty", async () => {
    expect(await getRemindedCalls()).toEqual({});
    await saveRemindedCalls({ a: { url: "https://meet.google.com/abc-defg-hij", at: 1 } });
    expect(await getRemindedCalls()).toEqual({ a: { url: "https://meet.google.com/abc-defg-hij", at: 1 } });
  });
});
