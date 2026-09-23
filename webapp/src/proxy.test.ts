import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "./proxy";
import { prisma } from "./lib/db";

const ORIGINAL_TOKEN = process.env.AUTH_TOKEN;

describe("proxy", () => {
  beforeEach(async () => {
    process.env.AUTH_TOKEN = "correct-token-value";
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });
  afterEach(() => {
    process.env.AUTH_TOKEN = ORIGINAL_TOKEN;
  });
  afterAll(async () => {
    await prisma.$disconnect();
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

  it("rejects a UI page request with a session cookie that doesn't resolve to a real session", async () => {
    const req = new NextRequest("http://localhost/meetings", {
      headers: { Cookie: "session=not-a-real-session-id" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(307);
  });

  it("allows a UI page request through with a valid, real session cookie", async () => {
    const user = await prisma.user.create({ data: { email: "person@example.com", passwordHash: "irrelevant" } });
    const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 100_000) } });

    const req = new NextRequest("http://localhost/meetings", {
      headers: { Cookie: `session=${session.id}` },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(401);
  });

  it("rejects an expired session cookie", async () => {
    const user = await prisma.user.create({ data: { email: "person@example.com", passwordHash: "irrelevant" } });
    const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() - 1000) } });

    const req = new NextRequest("http://localhost/meetings", {
      headers: { Cookie: `session=${session.id}` },
    });
    const res = await proxy(req);
    expect(res.status).toBe(307);
  });

  it("matcher config excludes Next internals and static assets", () => {
    expect(config.matcher).toBeDefined();
    expect(config.matcher[0]).toContain("_next/font");
    expect(config.matcher[0]).toContain("svg");
  });
});
