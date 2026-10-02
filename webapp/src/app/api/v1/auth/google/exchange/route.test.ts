import { beforeEach, describe, expect, it, vi } from "vitest";

const { createApiToken, apiErrorResponse, requestIdFrom, getEntitlements, managedHostingEnabled, readManagedJson, consumeGoogleExtensionCode, contextFromRequest, findUser, getUserRole } = vi.hoisted(() => ({
  createApiToken: vi.fn(),
  apiErrorResponse: vi.fn((error: unknown) => Response.json({ error: String(error) }, { status: 500 })),
  requestIdFrom: vi.fn(() => "request-1"),
  getEntitlements: vi.fn(),
  managedHostingEnabled: vi.fn(),
  readManagedJson: vi.fn(),
  consumeGoogleExtensionCode: vi.fn(),
  contextFromRequest: vi.fn(),
  findUser: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock("@/lib/apiTokens", () => ({ createApiToken }));
vi.mock("@/lib/apiErrors", () => ({ apiErrorResponse, requestIdFrom }));
vi.mock("@/lib/usageLedger", () => ({ getEntitlements }));
vi.mock("@/lib/managedAuth", () => ({ managedHostingEnabled }));
vi.mock("@/lib/managedJobs", () => ({
  readManagedJson,
  ManagedValidationError: class ManagedValidationError extends Error {},
}));
vi.mock("@/lib/googleIntegration", () => ({ consumeGoogleExtensionCode }));
vi.mock("@/lib/requestContext", () => ({ contextFromRequest }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: findUser } } }));
vi.mock("@/lib/workspaces", () => ({ getUserRole }));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  managedHostingEnabled.mockReturnValue(true);
  readManagedJson.mockImplementation(async (request: Request) => request.json());
  consumeGoogleExtensionCode.mockResolvedValue({ userId: "user-1", workspaceId: "workspace-1" });
  findUser.mockResolvedValue({ id: "user-1", mustChangePassword: false });
  getUserRole.mockResolvedValue("owner");
  createApiToken.mockResolvedValue({ token: "ant_secret", expiresAt: new Date("2027-01-01T00:00:00Z") });
  getEntitlements.mockResolvedValue({ plan: "hosted" });
  contextFromRequest.mockReturnValue({ userAgent: "Chrome" });
});

describe("Google extension code exchange", () => {
  it("mints a managed token only after exchanging the one-use code and confirming membership", async () => {
    const response = await POST(new Request("https://app.example.com/api/v1/auth/google/exchange", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "opaque-code", codeVerifier: "v".repeat(43) }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accessToken: "ant_secret", accountId: "user-1", workspaceId: "workspace-1", plan: "hosted", role: "owner",
    });
    expect(consumeGoogleExtensionCode).toHaveBeenCalledWith("opaque-code", "v".repeat(43));
    expect(createApiToken).toHaveBeenCalledWith("user-1", { userAgent: "Chrome", label: "Extension sign-in" });
  });

  it("does not mint a token for a bad or already consumed code", async () => {
    consumeGoogleExtensionCode.mockResolvedValue(null);
    const response = await POST(new Request("https://app.example.com/api/v1/auth/google/exchange", {
      method: "POST", body: JSON.stringify({ code: "invalid", codeVerifier: "v".repeat(43) }),
    }));
    expect(response.status).toBe(401);
    expect(createApiToken).not.toHaveBeenCalled();
  });

  it("requires active workspace membership before creating the managed token", async () => {
    getUserRole.mockResolvedValue(null);
    const response = await POST(new Request("https://app.example.com/api/v1/auth/google/exchange", {
      method: "POST", body: JSON.stringify({ code: "opaque-code", codeVerifier: "v".repeat(43) }),
    }));
    expect(response.status).toBe(403);
    expect(createApiToken).not.toHaveBeenCalled();
  });

  it("keeps this exchange disabled on self-hosted deployments", async () => {
    managedHostingEnabled.mockReturnValue(false);
    const response = await POST(new Request("https://app.example.com/api/v1/auth/google/exchange", { method: "POST" }));
    expect(response.status).toBe(404);
    expect(readManagedJson).not.toHaveBeenCalled();
  });
});
