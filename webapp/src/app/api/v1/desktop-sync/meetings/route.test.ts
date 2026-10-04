import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateDesktopSync,
  upsertMeeting,
  listDesktopSyncMeetingCandidates,
  listDesktopSyncMeetingDetails,
  apiErrorResponse,
  DesktopSyncConflictError,
} = vi.hoisted(() => ({
  authenticateDesktopSync: vi.fn(),
  upsertMeeting: vi.fn(),
  listDesktopSyncMeetingCandidates: vi.fn(),
  listDesktopSyncMeetingDetails: vi.fn(),
  apiErrorResponse: vi.fn(() => Response.json({ error: "internal error" }, { status: 500 })),
  DesktopSyncConflictError: class DesktopSyncConflictError extends Error {},
}));

vi.mock("@/lib/desktopSyncAuth", () => ({ authenticateDesktopSync }));
vi.mock("@/lib/meetings", () => ({
  upsertMeeting,
  listDesktopSyncMeetingCandidates,
  listDesktopSyncMeetingDetails,
  DesktopSyncConflictError,
}));
vi.mock("@/lib/apiErrors", () => ({
  apiErrorResponse,
  jsonError: (error: string, status: number, requestId: string) => Response.json({ error, requestId }, { status }),
  requestIdFrom: () => "desktop-sync-test",
}));

import { GET, POST } from "./route";

const endpoint = "https://notes.example.test/api/v1/desktop-sync/meetings";

beforeEach(() => {
  vi.clearAllMocks();
  authenticateDesktopSync.mockResolvedValue({ ok: true, auth: { userId: "user-1", workspaceId: "workspace-1", workspaceName: "Product" } });
  upsertMeeting.mockResolvedValue({ id: "meeting-1", title: "Planning", updatedAt: new Date("2026-10-04T12:00:00.000Z") });
  listDesktopSyncMeetingCandidates.mockResolvedValue([]);
  listDesktopSyncMeetingDetails.mockResolvedValue([]);
});

describe("GET /api/v1/desktop-sync/meetings", () => {
  it("returns authenticated workspace notes with a stable continuation cursor", async () => {
    const updatedAt = new Date("2026-10-04T12:00:00.000Z");
    listDesktopSyncMeetingCandidates.mockResolvedValueOnce([{
      id: "meeting-1", updatedAt,
    }]);
    listDesktopSyncMeetingDetails.mockResolvedValueOnce([{
      id: "meeting-1", title: "Planning", mode: "general",
      startedAt: new Date("2026-10-04T10:00:00.000Z"), endedAt: new Date("2026-10-04T10:30:00.000Z"),
      summary: "Plan", updatedAt,
      transcript: [{ speaker: "you", text: "Ship it", timestamp: null }],
      actionItems: [{ id: "action-1", text: "Ship", owner: null, status: "open", dueAt: null, completedAt: null }],
    }]);
    const response = await GET(new Request(endpoint + "?updatedAt=2026-10-03T12%3A00%3A00.000Z&id=meeting-0"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      hasMore: false,
      nextCursor: { updatedAt: "2026-10-04T12:00:00.000Z", id: "meeting-1" },
      meetings: [{ title: "Planning", transcript: [{ text: "Ship it", timestamp: null }], actionItems: [{ text: "Ship" }] }],
    });
    expect(listDesktopSyncMeetingCandidates).toHaveBeenCalledWith("workspace-1", {
      updatedAt: new Date("2026-10-03T12:00:00.000Z"), id: "meeting-0",
    }, 51);
    expect(listDesktopSyncMeetingDetails).toHaveBeenCalledWith("workspace-1", ["meeting-1"]);

    await GET(new Request(endpoint + "?updatedAt=2026-10-03T12%3A00%3A00.000Z"));
    expect(listDesktopSyncMeetingCandidates).toHaveBeenLastCalledWith("workspace-1", {
      updatedAt: new Date("2026-10-03T12:00:00.000Z"),
    }, 51);
  });

  it("loads note text in batches of four and preserves the cursor order", async () => {
    const updatedAt = new Date("2026-10-04T12:00:00.000Z");
    const candidates = Array.from({ length: 9 }, (_, index) => ({ id: `note-${index}`, updatedAt }));
    listDesktopSyncMeetingCandidates.mockResolvedValueOnce(candidates);
    listDesktopSyncMeetingDetails.mockImplementation(async (_workspaceId: string, ids: string[]) => ids.map((id) => ({
      id,
      title: id,
      mode: "general",
      startedAt: new Date("2026-10-04T10:00:00.000Z"),
      endedAt: new Date("2026-10-04T10:30:00.000Z"),
      summary: "Plan",
      updatedAt,
      transcript: [],
      actionItems: [],
    })));

    const response = await GET(new Request(endpoint));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meetings).toHaveLength(9);
    expect(body.nextCursor).toEqual({ updatedAt: updatedAt.toISOString(), id: "note-8" });
    expect(listDesktopSyncMeetingDetails.mock.calls.map(([, ids]) => ids)).toEqual([
      ["note-0", "note-1", "note-2", "note-3"],
      ["note-4", "note-5", "note-6", "note-7"],
      ["note-8"],
    ]);
  });

  it("returns a continuation cursor when every scanned note disappears before detail reads", async () => {
    const updatedAt = new Date("2026-10-04T12:00:00.000Z");
    listDesktopSyncMeetingCandidates.mockResolvedValueOnce(
      Array.from({ length: 51 }, (_, index) => ({ id: `deleted-${index}`, updatedAt })),
    );

    const response = await GET(new Request(endpoint));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      meetings: [],
      hasMore: true,
      nextCursor: { updatedAt: updatedAt.toISOString(), id: "deleted-50" },
    });
    expect(listDesktopSyncMeetingDetails).toHaveBeenCalledTimes(13);
  });

  it("rejects one note that exceeds the desktop reader limit", async () => {
    const updatedAt = new Date("2026-10-04T12:00:00.000Z");
    listDesktopSyncMeetingCandidates.mockResolvedValueOnce([{ id: "large-note", updatedAt }]);
    listDesktopSyncMeetingDetails.mockResolvedValueOnce([{
      id: "large-note", title: "Large note", mode: "general",
      startedAt: new Date("2026-10-04T10:00:00.000Z"), endedAt: new Date("2026-10-04T10:30:00.000Z"),
      summary: "x".repeat(16 * 1024 * 1024), updatedAt, transcript: [], actionItems: [],
    }]);

    const response = await GET(new Request(endpoint));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "workspace note is too large for desktop sync" });
  });

  it("rejects malformed cursors and propagates token scope failures", async () => {
    const invalid = await GET(new Request(endpoint + "?updatedAt=bad&id=meeting-1"));
    expect(invalid.status).toBe(400);
    expect(listDesktopSyncMeetingCandidates).not.toHaveBeenCalled();

    authenticateDesktopSync.mockResolvedValueOnce({ ok: false, status: 403, message: "workspace access removed" });
    const denied = await GET(new Request(endpoint));
    expect(denied.status).toBe(403);
    expect(listDesktopSyncMeetingCandidates).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/desktop-sync/meetings", () => {
  it("upserts a finished note under the token workspace", async () => {
    const payload = { id: "meeting-1", title: "Planning", transcript: [], summary: "Done", actionItems: [] };
    const response = await POST(new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ updatedAt: "2026-10-04T12:00:00.000Z" });
    expect(upsertMeeting).toHaveBeenCalledWith(payload, "workspace-1", "user-1", { expectedUpdatedAt: undefined });
  });

  it("passes the desktop version baseline and returns safe conflicts", async () => {
    const payload = { id: "meeting-1", title: "Planning", transcript: [], summary: "Done", actionItems: [] };
    const response = await POST(new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-desktop-sync-version": "2026-10-04T11:00:00.000Z" },
      body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(201);
    expect(upsertMeeting).toHaveBeenCalledWith(payload, "workspace-1", "user-1", {
      expectedUpdatedAt: new Date("2026-10-04T11:00:00.000Z"),
    });

    upsertMeeting.mockRejectedValueOnce(new DesktopSyncConflictError("This workspace note changed online."));
    const conflict = await POST(new Request(endpoint, {
      method: "POST",
      headers: { "x-desktop-sync-version": "new" },
      body: JSON.stringify(payload),
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "This workspace note changed online.", requestId: "desktop-sync-test" });
  });

  it("rejects notes labeled for another capture or processing path", async () => {
    for (const payload of [
      { id: "meeting-1", captureSource: "meet" },
      { id: "meeting-1", processingMode: "managed" },
    ]) {
      const response = await POST(new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }));
      expect(response.status).toBe(400);
    }

    expect(upsertMeeting).not.toHaveBeenCalled();
  });

  it("rejects unauthorized, oversized, missing, and malformed input", async () => {
    authenticateDesktopSync.mockResolvedValueOnce({ ok: false, status: 401, message: "token required" });
    expect((await POST(new Request(endpoint, { method: "POST" }))).status).toBe(401);

    const tooLargeByHeader = await POST(new Request(endpoint, {
      method: "POST",
      headers: { "content-length": String(17 * 1024 * 1024) },
      body: "{}",
    }));
    expect(tooLargeByHeader.status).toBe(413);

    expect((await POST(new Request(endpoint, { method: "POST" }))).status).toBe(400);
    const malformed = await POST(new Request(endpoint, { method: "POST", body: "{" }));
    expect(malformed.status).toBe(400);
    expect(upsertMeeting).not.toHaveBeenCalled();
  });

  it("bounds streamed bodies and sanitizes failures from note persistence", async () => {
    const cancel = vi.fn();
    const oversized = {
      headers: new Headers(),
      body: {
        getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(16 * 1024 * 1024 + 1) }), cancel }),
      },
    } as unknown as Request;
    expect((await POST(oversized)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();

    upsertMeeting.mockRejectedValueOnce(new Error("private database details"));
    const failed = await POST(new Request(endpoint, { method: "POST", body: "{}" }));
    expect(failed.status).toBe(500);
    expect(apiErrorResponse).toHaveBeenCalledWith(expect.any(Error), {
      requestId: "desktop-sync-test",
      fallbackMessage: "Desktop note sync failed.",
    });
  });
});
