import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, findWorkspace, streamWorkspaceMeetings } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  findWorkspace: vi.fn(),
  streamWorkspaceMeetings: vi.fn(),
}));

const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/currentUser", () => ({ requireSession }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findUnique: findWorkspace } } }));
vi.mock("../exportData", async (importOriginal) => ({ ...(await importOriginal<typeof import("../exportData")>()), streamWorkspaceMeetings }));

import { GET } from "./route";

const meeting = (id: string) => ({ id, title: `Meeting ${id}`, mode: "hosted", startedAt: "2026-09-30T10:00:00.000Z", endedAt: "2026-09-30T10:30:00.000Z", summary: null, markdown: "# m", transcript: [], actionItems: [] });

async function* batches(...groups: string[][]) {
  for (const group of groups) yield group.map(meeting);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ userId: "u1", workspaceId: "ws-1", role: "owner", email: "a@b.test", sessionId: "s1" });
  findWorkspace.mockResolvedValue({ id: "ws-1", name: "Acme" });
});

describe("GET /account/export", () => {
  it("streams valid JSON for the session's own workspace only", async () => {
    streamWorkspaceMeetings.mockReturnValue(batches(["a", "b"], ["c"]));
    const response = await GET();
    expect(streamWorkspaceMeetings).toHaveBeenCalledWith("ws-1");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="notetaker-export-Acme-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parsed = JSON.parse(await response.text());
    expect(parsed.workspace).toEqual({ id: "ws-1", name: "Acme" });
    expect(parsed.meetings.map((m: { id: string }) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("produces valid JSON for an empty workspace", async () => {
    streamWorkspaceMeetings.mockReturnValue(batches());
    expect(JSON.parse(await (await GET()).text()).meetings).toEqual([]);
  });

  it("refuses a non-owner and audits an owner's export", async () => {
    requireSession.mockResolvedValue({ userId: "u2", workspaceId: "ws-1", role: "member", email: "m@b.test", sessionId: "s2" });
    expect((await GET()).status).toBe(403);
    expect(recordAudit).not.toHaveBeenCalled();

    requireSession.mockResolvedValue({ userId: "u1", workspaceId: "ws-1", role: "owner", email: "a@b.test", sessionId: "s1" });
    streamWorkspaceMeetings.mockReturnValue(batches());
    await GET();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", actorUserId: "u1", action: "workspace.export" }));
  });

  it("returns 404 if the workspace vanished", async () => {
    findWorkspace.mockResolvedValue(null);
    expect((await GET()).status).toBe(404);
  });
});
