import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveApiToken, findWorkspace, getUserRole } = vi.hoisted(() => ({
  resolveApiToken: vi.fn(),
  findWorkspace: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock("./apiTokens", () => ({ DESKTOP_NOTES_SCOPE: "desktop_notes_sync", resolveApiToken }));
vi.mock("./db", () => ({ prisma: { workspace: { findUnique: findWorkspace } } }));
vi.mock("./workspaces", () => ({ getUserRole }));

import { authenticateDesktopSync } from "./desktopSyncAuth";

beforeEach(() => {
  vi.clearAllMocks();
  resolveApiToken.mockResolvedValue({ id: "user-1", email: "one@example.test", tokenId: "token-1", workspaceId: "workspace-1" });
  getUserRole.mockResolvedValue("member");
  findWorkspace.mockResolvedValue({ name: "Product" });
});

describe("desktop sync authentication", () => {
  it("accepts a workspace-bound token and rechecks membership", async () => {
    const request = new Request("https://notes.example.test/api/v1/desktop-sync", { headers: { authorization: "Bearer ant_secret" } });
    await expect(authenticateDesktopSync(request)).resolves.toEqual({
      ok: true,
      auth: { userId: "user-1", workspaceId: "workspace-1", workspaceName: "Product" },
    });
    expect(resolveApiToken).toHaveBeenCalledWith("ant_secret", expect.any(Number), "desktop_notes_sync");
    expect(getUserRole).toHaveBeenCalledWith("user-1", "workspace-1");
  });

  it("rejects missing, wrong-scope, or revoked tokens", async () => {
    const missing = await authenticateDesktopSync(new Request("https://notes.example.test/api/v1/desktop-sync"));
    expect(missing).toMatchObject({ ok: false, status: 401 });
    resolveApiToken.mockResolvedValueOnce(null);
    const invalid = await authenticateDesktopSync(new Request("https://notes.example.test/api/v1/desktop-sync", { headers: { authorization: "Bearer ant_wrong_scope" } }));
    expect(invalid).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a requested workspace mismatch and removed membership", async () => {
    const mismatch = await authenticateDesktopSync(new Request("https://notes.example.test/api/v1/desktop-sync", {
      headers: { authorization: "Bearer ant_secret", "x-workspace-id": "workspace-2" },
    }));
    expect(mismatch).toMatchObject({ ok: false, status: 403 });
    getUserRole.mockResolvedValueOnce(null);
    const removed = await authenticateDesktopSync(new Request("https://notes.example.test/api/v1/desktop-sync", { headers: { authorization: "Bearer ant_secret" } }));
    expect(removed).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a token whose workspace no longer exists", async () => {
    findWorkspace.mockResolvedValueOnce(null);
    const result = await authenticateDesktopSync(new Request("https://notes.example.test/api/v1/desktop-sync", {
      headers: { authorization: "Bearer ant_secret" },
    }));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});
