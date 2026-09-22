import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { getWebappSyncOutbox } from "../src/lib/storage";
import { syncMeetingToWebapp } from "../src/lib/webappSync";
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

beforeEach(() => chromeMock.reset());

describe("webapp sync durability", () => {
  it("queues a failed optional sync for a later flush", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    await expect(syncMeetingToWebapp(meeting, settings, fetchImpl)).resolves.toBe(false);
    expect(await getWebappSyncOutbox()).toEqual([meeting]);
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
});
