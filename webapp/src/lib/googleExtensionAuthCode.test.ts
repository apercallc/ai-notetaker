import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnique, deleteMany } = vi.hoisted(() => ({ create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() }));
vi.mock("./db", () => ({ prisma: { googleExtensionAuthCode: { create, findUnique, deleteMany } } }));

import { consumeGoogleExtensionCode, createGoogleExtensionCode, GOOGLE_EXTENSION_CODE_TTL_MS } from "./googleIntegration";

const verifier = "test-verifier-0123456789-test-verifier-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");

beforeEach(() => {
  vi.clearAllMocks();
  deleteMany.mockResolvedValue({ count: 1 });
});

describe("Google extension OAuth exchange codes", () => {
  it("stores a hash with a short expiry and returns only the opaque code", async () => {
    const before = Date.now();
    const code = await createGoogleExtensionCode({ userId: "user-1", workspaceId: "workspace-1", codeChallenge: challenge });
    const created = create.mock.calls[0][0].data;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.codeHash).toBe(createHash("sha256").update(code).digest("hex"));
    expect(created.codeHash).not.toBe(code);
    expect(created).toMatchObject({ userId: "user-1", workspaceId: "workspace-1", codeChallenge: challenge });
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + GOOGLE_EXTENSION_CODE_TTL_MS);
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + GOOGLE_EXTENSION_CODE_TTL_MS);
  });

  it("verifies PKCE and deletes exactly one active code", async () => {
    const code = "A".repeat(43);
    findUnique.mockResolvedValue({ codeChallenge: challenge, userId: "user-1", workspaceId: "workspace-1", expiresAt: new Date(Date.now() + 30_000) });
    await expect(consumeGoogleExtensionCode(code, verifier)).resolves.toEqual({ userId: "user-1", workspaceId: "workspace-1" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { codeHash: createHash("sha256").update(code).digest("hex"), expiresAt: { gt: expect.any(Date) } } });
  });

  it("leaves a code unconsumed on a wrong verifier and rejects expired or malformed inputs", async () => {
    const code = "B".repeat(43);
    findUnique.mockResolvedValue({ codeChallenge: challenge, userId: "user-1", workspaceId: "workspace-1", expiresAt: new Date(Date.now() + 30_000) });
    await expect(consumeGoogleExtensionCode(code, "wrong-verifier-0123456789-wrong-verifier-0123456789" )).resolves.toBeNull();
    expect(deleteMany).not.toHaveBeenCalled();

    findUnique.mockResolvedValue({ codeChallenge: challenge, userId: "user-1", workspaceId: "workspace-1", expiresAt: new Date(Date.now() - 1) });
    await expect(consumeGoogleExtensionCode(code, verifier)).resolves.toBeNull();
    await expect(consumeGoogleExtensionCode("bad", verifier)).resolves.toBeNull();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a code if another exchange already consumed it", async () => {
    const code = "C".repeat(43);
    findUnique.mockResolvedValue({ codeChallenge: challenge, userId: "user-1", workspaceId: "workspace-1", expiresAt: new Date(Date.now() + 30_000) });
    deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(consumeGoogleExtensionCode(code, verifier)).resolves.toBeNull();
  });
});
