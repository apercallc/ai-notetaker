import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock } from "./setup";
import {
  getSettings,
  saveSettings,
  getPairingToken,
  savePairingToken,
  listMeetings,
  saveMeeting,
  getMeeting,
  deleteMeeting,
  getWebappSyncOutbox,
  queueWebappSync,
  removeWebappSyncOutbox,
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

  it("never writes settings (or API keys) to chrome.storage.sync", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, apiKeys: { claude: "secret" } });
    expect(chromeMock.storage.sync.set).not.toHaveBeenCalled();
    expect(chromeMock.storage.local.set).toHaveBeenCalled();
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
});
