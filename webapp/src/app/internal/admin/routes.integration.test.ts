import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { GET as getHealth } from "./health/route";
import { GET as getMetrics } from "./metrics/route";
import { GET as getUsers } from "./users/route";
import { GET as getUser } from "./users/[userId]/route";

const token = "integration-admin-token-that-is-at-least-32-characters";
const savedToken = process.env.AI_NOTETAKER_ADMIN_API_TOKEN;
let createdUserId: string | undefined;

function request(path: string, authenticated = true): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(() => {
  process.env.AI_NOTETAKER_ADMIN_API_TOKEN = token;
});

afterAll(async () => {
  if (createdUserId) await prisma.user.deleteMany({ where: { id: createdUserId } });
  if (savedToken === undefined) delete process.env.AI_NOTETAKER_ADMIN_API_TOKEN;
  else process.env.AI_NOTETAKER_ADMIN_API_TOKEN = savedToken;
});

describe("Aperca Admin internal routes", () => {
  it("authenticates service calls and returns minimal account and signup data", async () => {
    const denied = await getUsers(request("/internal/admin/users", false));
    expect(denied.status).toBe(401);

    const email = `admin-integration-${randomUUID()}@example.test`;
    const createdAt = new Date();
    const user = await prisma.user.create({
      data: { email, passwordHash: "never-return-this", createdAt },
      select: { id: true },
    });
    createdUserId = user.id;

    const search = await getUsers(request(`/internal/admin/users?q=${encodeURIComponent(email)}`));
    expect(search.status).toBe(200);
    expect(search.headers.get("cache-control")).toBe("no-store");
    const searchBody = await search.json();
    expect(searchBody.users).toHaveLength(1);
    expect(searchBody.users[0]).toMatchObject({ email, status: "unknown", availableSupportActions: [] });
    expect(searchBody.users[0]).not.toHaveProperty("passwordHash");

    const profile = await getUser(request(`/internal/admin/users/${user.id}`), { params: Promise.resolve({ userId: user.id }) });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ id: user.id, email, availableSupportActions: [] });

    const from = new Date(createdAt.getTime() - 1_000).toISOString();
    const to = new Date(createdAt.getTime() + 1_000).toISOString();
    const metrics = await getMetrics(request(`/internal/admin/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
    expect(metrics.status).toBe(200);
    expect((await metrics.json()).metrics.newUsers).toBe(1);

    const health = await getHealth(request("/internal/admin/health"));
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe("healthy");
  }, 15_000);
});
