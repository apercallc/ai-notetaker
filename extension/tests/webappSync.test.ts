import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { getWebappSyncOutbox, saveMeeting } from "../src/lib/storage";
import { flushWebappSyncOutbox, syncMeetingToWebapp } from "../src/lib/webappSync";
import type { MeetingRecord } from "../src/types";

const meeting: MeetingRecord = {
  id: "meeting-1",
  title: "Planning",
  startedAt: "2026-09-21T10:00:00.000Z",
  endedAt: "2026-09-21T10:30:00.000Z",
  transcript: [],
  summary: "A plan",
  actionItems: [],
  status: "complete",
};

const settings = {
  webapp: { url: "https://notes.example.test", token: "secret" },
};

beforeEach(async () => {
  chromeMock.reset();
  await saveMeeting(meeting);
});

describe("webapp sync durability", () => {
  it("queues a failed optional sync for a later flush", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    await expect(syncMeetingToWebapp(meeting, settings, fetchImpl)).resolves.toBe(false);
    expect(await getWebappSyncOutbox()).toEqual([meeting]);
  });

  it("drops a meeting the server permanently refuses instead of retrying it forever", async () => {
    const queued = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await syncMeetingToWebapp(meeting, settings, queued);
    expect(await getWebappSyncOutbox()).toEqual([meeting]);

    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("too large", { status: 413 }));
    await expect(syncMeetingToWebapp(meeting, settings, rejected)).resolves.toBe(false);
    expect(await getWebappSyncOutbox()).toEqual([]);
  });

  it("keeps a meeting queued when the server is merely down or unauthorized", async () => {
    for (const status of [401, 429, 503]) {
      chromeMock.reset();
      await saveMeeting(meeting);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      await syncMeetingToWebapp(meeting, settings, fetchImpl);
      expect(await getWebappSyncOutbox()).toEqual([meeting]);
    }
  });

  it("removes the outbox entry after a successful sync", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await syncMeetingToWebapp(meeting, settings, fetchImpl);
    expect(await getWebappSyncOutbox()).toEqual([]);
  });

  it("does not send a bearer token to a non-canonical path", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      syncMeetingToWebapp(meeting, { webapp: { ...settings.webapp, url: "https://notes.example.test/app" } }, fetchImpl),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("can avoid re-queueing while flushing an outbox", async () => {
    await expect(syncMeetingToWebapp(meeting, settings, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")), { queueOnFailure: false })).resolves.toBe(false);
    expect(await getWebappSyncOutbox()).toEqual([]);
  });

  it("flushes each queued meeting without duplicating failures", async () => {
    await syncMeetingToWebapp(meeting, settings, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await flushWebappSyncOutbox(settings, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await getWebappSyncOutbox()).toEqual([]);
  });
});
