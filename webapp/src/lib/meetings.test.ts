import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import {
  upsertMeeting,
  listMeetings,
  getMeeting,
  deleteMeeting,
  listActionItems,
  updateActionItem,
  ValidationError,
} from "./meetings";
import type { CreateMeetingRequest } from "./types";

// These are real integration tests against a live Postgres (see webapp
// README for how to start one) — not mocked. Truth-in-testing matters more
// here than speed: the auth middleware and this data layer are the two
// places a bug would actually leak or corrupt a user's meeting notes.

function sampleMeeting(overrides: Partial<CreateMeetingRequest> = {}): CreateMeetingRequest {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "Weekly sync",
    startedAt: "2026-09-21T15:00:00.000Z",
    endedAt: "2026-09-21T15:45:00.000Z",
    summary: "Discussed Q4 roadmap and blockers.",
    transcript: [
      { speaker: "you", text: "Let's start with blockers.", timestamp: "2026-09-21T15:00:05.000Z" },
      { speaker: "them", text: "I'm blocked on the API keys.", timestamp: "2026-09-21T15:00:20.000Z" },
    ],
    actionItems: [{ text: "Send API keys", owner: "you" }],
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.actionItem.deleteMany();
  await prisma.transcriptSegment.deleteMany();
  await prisma.meeting.deleteMany();
});

afterAll(async () => {
  await prisma.actionItem.deleteMany();
  await prisma.transcriptSegment.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.$disconnect();
});

describe("upsertMeeting", () => {
  it("creates a new meeting with its transcript and action items", async () => {
    const input = sampleMeeting();
    const result = await upsertMeeting(input);

    expect(result.id).toBe(input.id);
    expect(result.title).toBe("Weekly sync");

    const detail = await getMeeting(input.id);
    expect(detail?.transcript).toHaveLength(2);
    expect(detail?.actionItems).toHaveLength(1);
    expect(detail?.actionItems[0].owner).toBe("you");
    expect(detail?.mode).toBe("general");
    expect(detail?.actionItems[0].status).toBe("open");
    expect(detail?.actionItems[0].id).toEqual(expect.any(String));
  });

  it("persists meeting modes and lets the action inbox update status and due dates", async () => {
    await upsertMeeting(
      sampleMeeting({
        mode: "sales",
        actionItems: [{ id: "action-1", text: "Send proposal", owner: "you", dueAt: "2026-09-25T00:00:00.000Z" }],
      }),
    );

    const openItems = await listActionItems("open");
    expect(openItems).toHaveLength(1);
    expect(openItems[0]?.id).toBe("action-1");
    expect(openItems[0]?.meeting.title).toBe("Weekly sync");

    expect(await updateActionItem("action-1", { status: "done", dueAt: null })).toBe(true);
    const detail = await getMeeting("11111111-1111-1111-1111-111111111111");
    expect(detail?.mode).toBe("sales");
    expect(detail?.actionItems[0]).toMatchObject({ status: "done", dueAt: null });
    expect(detail?.actionItems[0].completedAt).toEqual(expect.any(String));
    expect(await listActionItems("open")).toHaveLength(0);
    expect(await listActionItems("done")).toHaveLength(1);
  });

  it("defaults the title when none is provided", async () => {
    const input = sampleMeeting({ title: undefined });
    const result = await upsertMeeting(input);
    expect(result.title).toContain("Meeting on");
  });

  it("is idempotent: POSTing the same id twice upserts rather than duplicating", async () => {
    const input = sampleMeeting();
    await upsertMeeting(input);
    await upsertMeeting({ ...input, summary: "Updated summary after re-sync." });

    const all = await prisma.meeting.findMany();
    expect(all).toHaveLength(1);

    const detail = await getMeeting(input.id);
    expect(detail?.summary).toBe("Updated summary after re-sync.");
  });

  it("replaces transcript/action items on re-upsert rather than appending", async () => {
    const input = sampleMeeting();
    await upsertMeeting(input);
    await upsertMeeting({
      ...input,
      transcript: [{ speaker: "you", text: "Only one line now.", timestamp: "2026-09-21T15:00:05.000Z" }],
      actionItems: [],
    });

    const detail = await getMeeting(input.id);
    expect(detail?.transcript).toHaveLength(1);
    expect(detail?.actionItems).toHaveLength(0);
  });

  it("rejects a payload missing required fields", async () => {
    // upsertMeeting takes `unknown` (real callers are external HTTP clients,
    // not type-checked TS callers), so there's no compile-time error to
    // expect here — this is purely a runtime-validation test.
    await expect(upsertMeeting({ id: "x" })).rejects.toThrow(ValidationError);
  });

  it("rejects an empty transcript array element with no text", async () => {
    const input = sampleMeeting({
      // @ts-expect-error deliberately malformed for the test
      transcript: [{ speaker: "you", timestamp: "2026-09-21T15:00:05.000Z" }],
    });
    await expect(upsertMeeting(input)).rejects.toThrow(ValidationError);
  });

  it("rejects oversized payloads before they reach Prisma", async () => {
    await expect(upsertMeeting(sampleMeeting({ summary: "x".repeat(100_001) }))).rejects.toThrow(ValidationError);
    await expect(
      upsertMeeting(sampleMeeting({ actionItems: Array.from({ length: 1_001 }, () => ({ text: "too many" })) })),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects invalid meeting chronology and malformed optional owners", async () => {
    await expect(
      upsertMeeting(sampleMeeting({ startedAt: "2026-09-21T16:00:00.000Z" })),
    ).rejects.toThrow("endedAt must not be before startedAt");
    await expect(
      upsertMeeting(sampleMeeting({ actionItems: [{ text: "Follow up", owner: 42 as unknown as string }] })),
    ).rejects.toThrow(ValidationError);
  });
});

describe("listMeetings", () => {
  it("lists meetings newest-first", async () => {
    await upsertMeeting(sampleMeeting({ id: "11111111-1111-1111-1111-111111111111", startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T10:30:00.000Z" }));
    await upsertMeeting(sampleMeeting({ id: "22222222-2222-2222-2222-222222222222", startedAt: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T10:30:00.000Z" }));

    const { meetings, total } = await listMeetings({});
    expect(total).toBe(2);
    expect(meetings[0].id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("full-text searches title and summary", async () => {
    await upsertMeeting(
      sampleMeeting({ id: "11111111-1111-1111-1111-111111111111", title: "Roadmap planning", summary: "Discussed Q4 roadmap and blockers." })
    );
    await upsertMeeting(
      sampleMeeting({ id: "22222222-2222-2222-2222-222222222222", title: "1:1 with Sam", summary: "Career growth check-in." })
    );

    const { meetings } = await listMeetings({ query: "roadmap" });
    expect(meetings).toHaveLength(1);
    expect(meetings[0].title).toBe("Roadmap planning");
  });

  it("paginates with limit/offset", async () => {
    for (let i = 0; i < 5; i++) {
      await upsertMeeting(
        sampleMeeting({
          id: `${i}1111111-1111-1111-1111-111111111111`,
          startedAt: `2026-09-2${i}T10:00:00.000Z`,
          endedAt: `2026-09-2${i}T10:30:00.000Z`,
        })
      );
    }

    const page1 = await listMeetings({ limit: 2, offset: 0 });
    const page2 = await listMeetings({ limit: 2, offset: 2 });
    expect(page1.meetings).toHaveLength(2);
    expect(page2.meetings).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.meetings[0].id).not.toBe(page2.meetings[0].id);
  });

  it("rejects an offset that would force an unbounded deep scan", async () => {
    await expect(listMeetings({ offset: 100_001 })).rejects.toThrow(ValidationError);
  });
});

describe("getMeeting", () => {
  it("returns null for a meeting that doesn't exist", async () => {
    expect(await getMeeting("does-not-exist")).toBeNull();
  });
});

describe("deleteMeeting", () => {
  it("deletes a meeting and cascades its transcript/action items", async () => {
    const input = sampleMeeting();
    await upsertMeeting(input);

    await deleteMeeting(input.id);

    expect(await getMeeting(input.id)).toBeNull();
    expect(await prisma.transcriptSegment.count()).toBe(0);
    expect(await prisma.actionItem.count()).toBe(0);
  });

  it("does not throw when deleting a meeting that doesn't exist", async () => {
    await expect(deleteMeeting("does-not-exist")).resolves.not.toThrow();
  });
});
