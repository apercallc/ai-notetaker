import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnique, deleteMany, updateMany, findMany } = vi.hoisted(() => ({
  create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(),
}));
vi.mock("./db", () => ({ prisma: { apiToken: { create, findUnique, deleteMany, updateMany, findMany } } }));

import { API_TOKEN_LIFETIME_MS, API_TOKEN_PREFIX, DESKTOP_NOTES_SCOPE, createApiToken, hashToken, listApiTokens, looksLikeApiToken, resolveApiToken, revokeAllApiTokens, revokeApiToken, revokeApiTokenBySecret } from "./apiTokens";

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "token-row-1" });
  deleteMany.mockResolvedValue({ count: 1 });
  updateMany.mockResolvedValue({ count: 1 });
  findMany.mockResolvedValue([]);
});

describe("managed API token lifecycle", () => {
  it("hashes secrets and stores only bounded metadata with a 90-day expiry", async () => {
    const result = await createApiToken("user-1", { label: ` ${"L".repeat(100)} `, userAgent: "U".repeat(320), now: 1_000 });
    expect(result.id).toBe("token-row-1");
    expect(result.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(result.expiresAt.getTime()).toBe(1_000 + API_TOKEN_LIFETIME_MS);
    expect(looksLikeApiToken(result.token)).toBe(true);
    expect(looksLikeApiToken("session-cookie")).toBe(false);
    expect(hashToken(result.token)).toMatch(/^[a-f0-9]{64}$/);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ data: {
      userId: "user-1", scope: "managed", label: "L".repeat(80), userAgent: "U".repeat(300),
      tokenHash: hashToken(result.token), lastUsedAt: new Date(1_000), expiresAt: result.expiresAt,
    } });
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("token");
  });

  it("binds desktop sync tokens to one workspace and rejects unbound creation", async () => {
    await expect(createApiToken("user-1", { scope: DESKTOP_NOTES_SCOPE })).rejects.toThrow("bound to a workspace");
    const created = await createApiToken("user-1", { scope: DESKTOP_NOTES_SCOPE, workspaceId: "workspace-7", now: 2_000 });
    expect(created.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(create.mock.calls.at(-1)?.[0].data).toMatchObject({ scope: DESKTOP_NOTES_SCOPE, workspaceId: "workspace-7" });
  });

  it("keeps only the newest tokens per user and never fails a sign-in over housekeeping", async () => {
    const newest = Array.from({ length: 25 }, (_, index) => ({ id: `keep-${index}` }));
    findMany.mockResolvedValueOnce(newest);
    await createApiToken("user-1", { now: 5_000 });
    const prune = deleteMany.mock.calls.map((call) => call[0]?.where).find((where) => where?.id?.notIn);
    expect(prune).toMatchObject({ userId: "user-1", scope: "managed", id: { notIn: newest.map((row) => row.id) } });
    // The cap counts only tokens of the scope being created.
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: "user-1", scope: "managed" });

    findMany.mockResolvedValueOnce(newest);
    deleteMany.mockClear();
    await createApiToken("user-1", { now: 5_500, scope: DESKTOP_NOTES_SCOPE, workspaceId: "w1" });
    const desktopPrune = deleteMany.mock.calls.map((call) => call[0]?.where).find((where) => where?.id?.notIn);
    expect(desktopPrune).toMatchObject({ userId: "user-1", scope: DESKTOP_NOTES_SCOPE });

    findMany.mockResolvedValueOnce([{ id: "only-one" }]);
    deleteMany.mockClear();
    await createApiToken("user-1", { now: 6_000 });
    expect(deleteMany.mock.calls.some((call) => call[0]?.where?.id?.notIn)).toBe(false);

    deleteMany.mockRejectedValue(new Error("db blip"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createApiToken("user-1", { now: 7_000 })).resolves.toMatchObject({ id: "token-row-1" });
    log.mockRestore();
  });

  it("ignores malformed, revoked, foreign-scope, expired, and temporary-password credentials", async () => {
    expect(await resolveApiToken("" )).toBeNull();
    expect(await resolveApiToken("cookie-id")).toBeNull();
    expect(await resolveApiToken(`${API_TOKEN_PREFIX}${"x".repeat(200)}`)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();

    const base = { id: "row-1", revokedAt: null, scope: "managed", expiresAt: new Date(100_000), lastUsedAt: new Date(100_000), user: { id: "user-1", email: "a@example.com", mustChangePassword: false } };
    findUnique.mockResolvedValueOnce(null);
    expect(await resolveApiToken(`${API_TOKEN_PREFIX}unknown`, 1)).toBeNull();
    findUnique.mockResolvedValueOnce({ ...base, revokedAt: new Date(1) });
    expect(await resolveApiToken(`${API_TOKEN_PREFIX}revoked`, 1)).toBeNull();
    findUnique.mockResolvedValueOnce({ ...base, scope: "other" });
    expect(await resolveApiToken(`${API_TOKEN_PREFIX}scope`, 1)).toBeNull();
    findUnique.mockResolvedValueOnce({ ...base, expiresAt: new Date(100) });
    expect(await resolveApiToken(`${API_TOKEN_PREFIX}expired`, 100)).toBeNull();
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "row-1" } });
    findUnique.mockResolvedValueOnce({ ...base, user: { ...base.user, mustChangePassword: true } });
    expect(await resolveApiToken(`${API_TOKEN_PREFIX}temporary`, 1)).toBeNull();
  });

  it("touches idle tokens to extend their sliding expiry but leaves recently used tokens read-only", async () => {
    const token = `${API_TOKEN_PREFIX}valid-secret`;
    const row = { id: "row-2", revokedAt: null, scope: "managed", workspaceId: null, expiresAt: new Date(300_000), user: { id: "user-2", email: "b@example.com", mustChangePassword: false } };
    findUnique.mockResolvedValueOnce({ ...row, lastUsedAt: null });
    expect(await resolveApiToken(token, 200_000)).toEqual({ id: "user-2", email: "b@example.com", tokenId: "row-2", workspaceId: null });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "row-2", revokedAt: null }, data: { lastUsedAt: new Date(200_000), expiresAt: new Date(200_000 + API_TOKEN_LIFETIME_MS) } });

    updateMany.mockClear();
    findUnique.mockResolvedValueOnce({ ...row, lastUsedAt: new Date(200_000 - 60 * 60 * 1_000) });
    expect(await resolveApiToken(token, 200_000)).toEqual({ id: "user-2", email: "b@example.com", tokenId: "row-2", workspaceId: null });
    expect(updateMany).not.toHaveBeenCalled();

    findUnique.mockResolvedValueOnce({ ...row, lastUsedAt: new Date(200_000 - 60 * 60 * 1_000 - 1) });
    await resolveApiToken(token, 200_000);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("revokes tokens only through the requested owner scope and lists active token metadata", async () => {
    expect(await revokeApiToken("user-1", "token-1")).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "token-1", userId: "user-1" } });
    deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await revokeApiToken("user-1", "other-user-token")).toBe(false);
    expect(await revokeApiTokenBySecret("opaque-cookie")).toBe(false);
    expect(await revokeApiTokenBySecret(`${API_TOKEN_PREFIX}secret`)).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { tokenHash: hashToken(`${API_TOKEN_PREFIX}secret`) } });
    expect(await revokeAllApiTokens("user-1")).toBe(1);
    await listApiTokens("user-1", 123);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1", revokedAt: null, expiresAt: { gt: new Date(123) } } }));
  });
});
