import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateDesktopSync, upsertMeeting, apiErrorResponse } = vi.hoisted(() => ({
  authenticateDesktopSync: vi.fn(),
  upsertMeeting: vi.fn(),
  apiErrorResponse: vi.fn(() => Response.json({ error: "internal error" }, { status: 500 })),
}));

vi.mock("@/lib/desktopSyncAuth", () => ({ authenticateDesktopSync }));
vi.mock("@/lib/meetings", () => ({ upsertMeeting }));
vi.mock("@/lib/apiErrors", () => ({
  apiErrorResponse,
  jsonError: (error: string, status: number, requestId: string) => Response.json({ error, requestId }, { status }),
  requestIdFrom: () => "desktop-sync-test",
}));

import { POST } from "./route";

const endpoint = "https://notes.example.test/api/v1/desktop-sync/meetings";

beforeEach(() => {
  vi.clearAllMocks();
  authenticateDesktopSync.mockResolvedValue({ ok: true, auth: { userId: "user-1", workspaceId: "workspace-1", workspaceName: "Product" } });
  upsertMeeting.mockResolvedValue({ id: "meeting-1", title: "Planning" });
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
    expect(upsertMeeting).toHaveBeenCalledWith(payload, "workspace-1", "user-1");
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
