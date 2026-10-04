import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateDesktopSync, apiErrorResponse } = vi.hoisted(() => ({
  authenticateDesktopSync: vi.fn(),
  apiErrorResponse: vi.fn(() => Response.json({ error: "internal error" }, { status: 500 })),
}));

vi.mock("@/lib/desktopSyncAuth", () => ({ authenticateDesktopSync }));
vi.mock("@/lib/apiErrors", () => ({
  apiErrorResponse,
  requestIdFrom: () => "desktop-sync-test",
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  authenticateDesktopSync.mockResolvedValue({
    ok: true,
    auth: { userId: "user-1", workspaceId: "workspace-1", workspaceName: "Product" },
  });
});

describe("GET /api/v1/desktop-sync", () => {
  it("returns the authenticated workspace without caching", async () => {
    const response = await GET(new Request("https://notes.example.test/api/v1/desktop-sync"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, workspace: { id: "workspace-1", name: "Product" } });
  });

  it("preserves authentication failures and sanitizes unexpected errors", async () => {
    authenticateDesktopSync.mockResolvedValueOnce({ ok: false, status: 403, message: "workspace access removed" });
    const denied = await GET(new Request("https://notes.example.test/api/v1/desktop-sync"));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.json()).toMatchObject({ error: "workspace access removed", requestId: "desktop-sync-test" });

    authenticateDesktopSync.mockRejectedValueOnce(new Error("secret database detail"));
    const failed = await GET(new Request("https://notes.example.test/api/v1/desktop-sync"));
    expect(failed.status).toBe(500);
    expect(apiErrorResponse).toHaveBeenCalledWith(expect.any(Error), {
      requestId: "desktop-sync-test",
      fallbackMessage: "Desktop sync is temporarily unavailable.",
    });
  });
});
