import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getSessionUser = vi.fn();

vi.mock("./lib/sessions", () => ({ getSessionUser }));
vi.mock("./lib/auth", () => ({ isAuthorizedBearer: vi.fn(() => false) }));

const { proxy } = await import("./proxy");

function request(path: string, init: { method?: string; headers?: HeadersInit; body?: BodyInit | null } = {}): NextRequest {
  return new NextRequest(`https://notes.example.test${path}`, init);
}

describe("managed API proxy boundaries", () => {
  beforeEach(() => {
    getSessionUser.mockReset();
    delete process.env.MANAGED_WORKER_TOKEN;
    delete process.env.MANAGED_EXTENSION_ORIGIN;
  });

  it("allows managed login to reach the public login handler", async () => {
    const response = await proxy(request("/api/v1/auth/login", { method: "POST" }));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("still requires a managed session for protected v1 routes", async () => {
    const response = await proxy(request("/api/v1/meetings", { method: "POST", headers: { "x-request-id": "proxy-managed-auth-test" } }));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("proxy-managed-auth-test");
    expect(await response.json()).toEqual({ error: "managed session required", requestId: "proxy-managed-auth-test" });
  });

  it("allows preflight only for the fixed extension origin", async () => {
    const origin = "chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok";
    const response = await proxy(request("/api/v1/uploads", { method: "OPTIONS", headers: { origin } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("rejects cross-origin managed API preflight instead of using a wildcard", async () => {
    const response = await proxy(request("/api/v1/uploads", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps the legacy bearer boundary correlated too", async () => {
    const response = await proxy(request("/api/meetings", { method: "GET", headers: { "x-request-id": "proxy-legacy-auth-test" } }));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("proxy-legacy-auth-test");
    expect(await response.json()).toEqual({ error: "unauthorized", requestId: "proxy-legacy-auth-test" });
  });

  it("allows a correctly authenticated worker to reach its internal routes", async () => {
    process.env.MANAGED_WORKER_TOKEN = "worker-secret";
    const response = await proxy(request("/api/v1/jobs/next", { method: "POST", headers: { "x-worker-token": "worker-secret" } }));
    expect(response.status).toBe(200);
    expect(getSessionUser).not.toHaveBeenCalled();
  });
});
