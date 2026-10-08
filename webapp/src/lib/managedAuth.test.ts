import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getSessionContext: vi.fn(), resolveActiveWorkspace: vi.fn() }));
vi.mock("./sessions", () => ({ getSessionContext: h.getSessionContext, getSessionUser: vi.fn() }));
vi.mock("./workspaces", () => ({
  getUserDefaultWorkspaceId: vi.fn(),
  getUserRole: vi.fn(),
  resolveActiveWorkspace: h.resolveActiveWorkspace,
}));

import { getBrowserManagedSession } from "./managedAuth";

const BROWSER_API_HEADER = "x-notetaker-browser";
const original = { managed: process.env.MANAGED_HOSTING, url: process.env.APP_URL };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MANAGED_HOSTING = "true";
  process.env.APP_URL = "https://notes.example.com";
  h.getSessionContext.mockResolvedValue({ user: { id: "u1", email: "u@example.com", mustChangePassword: false }, activeWorkspaceId: "w1" });
  h.resolveActiveWorkspace.mockResolvedValue({ workspaceId: "w1", role: "owner" });
});

afterEach(() => {
  if (original.managed === undefined) delete process.env.MANAGED_HOSTING; else process.env.MANAGED_HOSTING = original.managed;
  if (original.url === undefined) delete process.env.APP_URL; else process.env.APP_URL = original.url;
});

const req = (origin: string | null) =>
  new Request("https://0.0.0.0:8080/api/import", {
    method: "POST",
    headers: { cookie: "session=abc", [BROWSER_API_HEADER]: "1", ...(origin ? { origin } : {}) },
  });

describe("getBrowserManagedSession same-origin check", () => {
  it("accepts the public APP_URL origin even though request.url is the internal address", async () => {
    expect(await getBrowserManagedSession(req("https://notes.example.com"))).toMatchObject({ userId: "u1", workspaceId: "w1", role: "owner" });
  });

  it("rejects a missing, foreign, or internal-address Origin", async () => {
    expect(await getBrowserManagedSession(req(null))).toBeNull();
    expect(await getBrowserManagedSession(req("https://evil.example"))).toBeNull();
    expect(await getBrowserManagedSession(req("https://0.0.0.0:8080"))).toBeNull();
  });
});
