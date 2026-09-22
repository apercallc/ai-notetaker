import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "./proxy";

const ORIGINAL_TOKEN = process.env.AUTH_TOKEN;

describe("proxy", () => {
  beforeEach(() => {
    process.env.AUTH_TOKEN = "correct-token-value";
  });
  afterEach(() => {
    process.env.AUTH_TOKEN = ORIGINAL_TOKEN;
  });

  it("allows GET /api/health with no auth at all", async () => {
    const req = new NextRequest("http://localhost/api/health");
    const res = await proxy(req);
    expect(res.status).not.toBe(401);
  });

  it("rejects /api/meetings with a 401 when no Authorization header is present", async () => {
    const req = new NextRequest("http://localhost/api/meetings");
    const res = await proxy(req);
    expect(res.status).toBe(401);
  });

  it("rejects /api/meetings with a 401 when the Bearer token is wrong", async () => {
    const req = new NextRequest("http://localhost/api/meetings", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(401);
  });

  it("allows /api/meetings through when the Bearer token is correct", async () => {
    const req = new NextRequest("http://localhost/api/meetings", {
      headers: { Authorization: "Bearer correct-token-value" },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(401);
  });

  it("allows /login with no auth (or you could never log in)", async () => {
    const req = new NextRequest("http://localhost/login");
    const res = await proxy(req);
    expect(res.status).not.toBe(401);
    // must not redirect either, or /login would loop
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects an unauthenticated UI page request to /login", async () => {
    const req = new NextRequest("http://localhost/meetings");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("allows a UI page request through with a valid session cookie", async () => {
    const req = new NextRequest("http://localhost/meetings", {
      headers: { Cookie: "session=correct-token-value" },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(401);
  });

  it("matcher config excludes Next internals and static assets", () => {
    expect(config.matcher).toBeDefined();
    expect(config.matcher[0]).toContain("_next/font");
    expect(config.matcher[0]).toContain("svg");
  });
});
