import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveApiToken, findWorkspace, findSubscription, getUserRole } = vi.hoisted(() => ({
  findSubscription: vi.fn(),
  resolveApiToken: vi.fn(),
  findWorkspace: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock("./apiTokens", () => ({ DESKTOP_NOTES_SCOPE: "desktop_notes_sync", resolveApiToken }));
vi.mock("./db", () => ({ prisma: { workspace: { findUnique: findWorkspace }, workspaceSubscription: { findUnique: findSubscription } } }));
vi.mock("./workspaces", () => ({ getUserRole }));

import { authenticateDesktopSync } from "./desktopSyncAuth";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("desktop sync is a subscription feature on the managed service", () => {
  const request = () => new Request("https://notes.example.test/api/v1/desktop-sync", { headers: { authorization: "Bearer ant_secret" } });
  const write = { write: true };

  beforeEach(() => {
    vi.stubEnv("MANAGED_HOSTING", "true");
  });

  it("allows an active Pro or Team subscription", async () => {
    findSubscription.mockResolvedValueOnce({ plan: "hosted_pro", status: "active", graceEndsAt: null });
    await expect(authenticateDesktopSync(request(), write)).resolves.toMatchObject({ ok: true });
    findSubscription.mockResolvedValueOnce({ plan: "hosted_team", status: "trialing", graceEndsAt: null });
    await expect(authenticateDesktopSync(request(), write)).resolves.toMatchObject({ ok: true });
  });

  it("answers 402 with no subscription, a canceled one, or the retired trial plan", async () => {
    for (const subscription of [null, { plan: "hosted_pro", status: "canceled", graceEndsAt: null }, { plan: "hosted_trial", status: "trialing", graceEndsAt: null }, { plan: "local", status: "inactive", graceEndsAt: null }]) {
      findSubscription.mockResolvedValueOnce(subscription);
      await expect(authenticateDesktopSync(request(), write)).resolves.toMatchObject({ ok: false, status: 402 });
    }
  });

  it("keeps sync during the payment grace window only", async () => {
    findSubscription.mockResolvedValueOnce({ plan: "hosted_pro", status: "past_due", graceEndsAt: new Date(Date.now() + 60_000) });
    await expect(authenticateDesktopSync(request(), write)).resolves.toMatchObject({ ok: true });
    findSubscription.mockResolvedValueOnce({ plan: "hosted_pro", status: "past_due", graceEndsAt: new Date(Date.now() - 60_000) });
    await expect(authenticateDesktopSync(request(), write)).resolves.toMatchObject({ ok: false, status: 402 });
  });

  it("never gates reading: a workspace whose plan ended can still download its notes", async () => {
    // Whatever the plan is, a read is answered without even looking at it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(authenticateDesktopSync(request())).resolves.toMatchObject({ ok: true });
    }
    expect(findSubscription).not.toHaveBeenCalled();
  });

  it("does not gate a deployment without managed hosting", async () => {
    vi.stubEnv("MANAGED_HOSTING", "false");
    await expect(authenticateDesktopSync(request(), write)).resolves.toMatchObject({ ok: true });
    expect(findSubscription).not.toHaveBeenCalled();
  });
});
