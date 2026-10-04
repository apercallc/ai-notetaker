import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getSessionUser = vi.fn();

vi.mock("./lib/sessions", () => ({ getSessionUser }));
vi.mock("./lib/auth", () => ({ isAuthorizedBearer: vi.fn(() => false) }));

const { config, contentSecurityPolicy, proxy } = await import("./proxy");

function request(path: string, init: { method?: string; headers?: HeadersInit; body?: BodyInit | null } = {}): NextRequest {
  return new NextRequest(`https://notes.example.test${path}`, init);
}

describe("managed API proxy boundaries", () => {
  const originalManagedHosting = process.env.MANAGED_HOSTING;

  beforeEach(() => {
    getSessionUser.mockReset();
    delete process.env.MANAGED_WORKER_TOKEN;
    delete process.env.MANAGED_EXTENSION_ORIGIN;
    if (originalManagedHosting === undefined) delete process.env.MANAGED_HOSTING;
    else process.env.MANAGED_HOSTING = originalManagedHosting;
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

  it("lets the dedicated desktop sync handler authenticate its workspace token", async () => {
    const response = await proxy(request("/api/v1/desktop-sync/meetings", {
      method: "POST",
      headers: { authorization: "Bearer ant_desktop", origin: "tauri://localhost" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(getSessionUser).not.toHaveBeenCalled();
  });

  it("answers 503 with Retry-After, not 401, when the session store is down", async () => {
    getSessionUser.mockRejectedValue(new Error("connection refused"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = await proxy(request("/api/v1/meetings", { method: "POST", headers: { authorization: "Bearer some-session", "x-request-id": "db-down" } }));
    expect(api.status).toBe(503);
    expect(api.headers.get("retry-after")).toBe("5");
    expect(await api.json()).toEqual({ error: "service temporarily unavailable", requestId: "db-down" });

    const page = await proxy(request("/meetings", { headers: { cookie: "session=abc" } }));
    expect(page.status).toBe(503);
    expect(page.headers.get("location")).toBeNull();
    log.mockRestore();
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

describe("page content security policy", () => {
  it("forwards a unique nonce to Next.js and omits unsafe-inline from production scripts", async () => {
    getSessionUser.mockResolvedValue({ userId: "user-1" });
    const first = await proxy(request("/"));
    const second = await proxy(request("/"));
    const policy = first.headers.get("content-security-policy") ?? "";
    const nonce = first.headers.get("x-middleware-request-x-nonce");
    const productionPolicy = contentSecurityPolicy("test-nonce", false);
    expect(nonce).toBeTruthy();
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(productionPolicy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(productionPolicy).not.toContain("unsafe-eval");
    expect(second.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
    expect(second.headers.get("content-security-policy")).not.toBe(policy);
  });

  it("allows inline style attributes explicitly, because a style-src nonce makes browsers ignore unsafe-inline", () => {
    const productionPolicy = contentSecurityPolicy("test-nonce", false);
    expect(productionPolicy).toContain("style-src-attr 'unsafe-inline'");
    // <style> elements stay nonce-gated: attributes cannot run script, elements can carry rules.
    expect(productionPolicy).toMatch(/style-src 'self' 'unsafe-inline' 'nonce-test-nonce'/);
  });
});

describe("public marketing routes", () => {
  const originalManagedHosting = process.env.MANAGED_HOSTING;

  beforeEach(() => {
    getSessionUser.mockReset();
    getSessionUser.mockResolvedValue(null);
    process.env.MANAGED_HOSTING = "true";
  });

  afterEach(() => {
    if (originalManagedHosting === undefined) delete process.env.MANAGED_HOSTING;
    else process.env.MANAGED_HOSTING = originalManagedHosting;
  });

  it.each(["/", "/how-it-works", "/pricing", "/download", "/compare", "/privacy", "/terms"])(
    "serves %s without a session on the managed deployment",
    async (path) => {
      const response = await proxy(request(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-marketing")).toBe("1");
      expect(response.headers.get("content-security-policy")).toContain("'nonce-");
      expect(getSessionUser).not.toHaveBeenCalled();
    },
  );

  it("keeps every app route behind a session, including lookalike marketing paths", async () => {
    for (const path of ["/meetings", "/actions", "/account", "/billing", "/team", "/pricing/anything", "/privacy/", "/pricing.json"]) {
      const response = await proxy(request(path));
      expect(response.headers.get("location"), path).toContain("/login");
      expect(response.headers.get("x-middleware-request-x-marketing"), path).toBeNull();
    }
  });

  it("never publishes marketing pages on a self-hosted instance", async () => {
    delete process.env.MANAGED_HOSTING;
    for (const path of ["/", "/pricing", "/download", "/privacy"]) {
      const response = await proxy(request(path));
      expect(response.headers.get("location"), path).toContain("/login");
    }
  });

  it("ignores a client-supplied marketing header on app pages", async () => {
    getSessionUser.mockResolvedValue({ userId: "user-1" });
    const response = await proxy(request("/meetings", { headers: { "x-marketing": "1" } }));
    expect(response.headers.get("x-middleware-request-x-marketing")).toBeNull();
  });
});

describe("legacy AUTH_TOKEN ingest availability", () => {
  beforeEach(() => {
    delete process.env.LEGACY_INGEST_ENABLED;
  });

  it("keeps the legacy ingest API available on self-hosted deployments", async () => {
    delete process.env.MANAGED_HOSTING;
    const response = await proxy(request("/api/meetings", { method: "GET" }));
    expect(response.status).toBe(401);
  });

  it("returns not found for the legacy ingest API in managed mode", async () => {
    process.env.MANAGED_HOSTING = "true";
    const response = await proxy(request("/api/meetings", { method: "GET", headers: { authorization: "Bearer anything", "x-request-id": "proxy-legacy-off" } }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found", requestId: "proxy-legacy-off" });

    const detail = await proxy(request("/api/meetings/some-id", { method: "DELETE" }));
    expect(detail.status).toBe(404);
  });

  it("lets an operator opt back into the legacy ingest API in managed mode", async () => {
    process.env.MANAGED_HOSTING = "true";
    process.env.LEGACY_INGEST_ENABLED = "true";
    const response = await proxy(request("/api/meetings", { method: "GET" }));
    expect(response.status).toBe(401);
  });
});

describe("proxy matcher", () => {
  const matches = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

  it("skips static assets but never an /api path that merely ends in an asset extension", () => {
    expect(matches("/logo.png")).toBe(false);
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/api/meetings/abc.png")).toBe(true);
    expect(matches("/api/meetings/abc")).toBe(true);
  });
});
