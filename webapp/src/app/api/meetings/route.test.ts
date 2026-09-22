import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { GET as GET_ONE, DELETE as DELETE_ONE } from "./[id]/route";
import { GET as GET_HEALTH } from "../health/route";
import { prisma } from "@/lib/db";

function meetingPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    title: "API route test meeting",
    startedAt: "2026-09-21T15:00:00.000Z",
    endedAt: "2026-09-21T15:30:00.000Z",
    summary: "A meeting created through the actual route handler.",
    transcript: [{ speaker: "you", text: "Hello.", timestamp: "2026-09-21T15:00:01.000Z" }],
    actionItems: [{ text: "Follow up" }],
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.actionItem.deleteMany();
  await prisma.transcriptSegment.deleteMany();
  await prisma.meeting.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/health", () => {
  it("returns ok without needing auth (enforced by middleware, not this handler)", async () => {
    const res = await GET_HEALTH();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /api/meetings", () => {
  it("creates a meeting and returns 201", async () => {
    const req = new NextRequest("http://localhost/api/meetings", {
      method: "POST",
      body: JSON.stringify(meetingPayload()),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("returns 400 for a malformed payload instead of a raw 500", async () => {
    const req = new NextRequest("http://localhost/api/meetings", {
      method: "POST",
      body: JSON.stringify({ id: "only-an-id" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON instead of throwing", async () => {
    const req = new NextRequest("http://localhost/api/meetings", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects oversized request bodies before parsing them", async () => {
    const req = new NextRequest("http://localhost/api/meetings", {
      method: "POST",
      headers: { "content-length": String(16 * 1024 * 1024 + 1) },
      body: "{}",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});

describe("GET /api/meetings", () => {
  it("lists meetings just created via POST", async () => {
    await POST(new NextRequest("http://localhost/api/meetings", { method: "POST", body: JSON.stringify(meetingPayload()) }));

    const res = await GET(new NextRequest("http://localhost/api/meetings"));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.meetings[0].id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("returns 400 for invalid pagination instead of passing NaN to Prisma", async () => {
    const res = await GET(new NextRequest("http://localhost/api/meetings?limit=not-a-number"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "limit must be a non-negative integer" });
  });

  it("returns 400 for an overlong search query", async () => {
    const query = "x".repeat(201);
    const res = await GET(new NextRequest(`http://localhost/api/meetings?query=${query}`));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/meetings/:id", () => {
  it("returns full detail for an existing meeting", async () => {
    await POST(new NextRequest("http://localhost/api/meetings", { method: "POST", body: JSON.stringify(meetingPayload()) }));

    const res = await GET_ONE(new Request("http://localhost/api/meetings/33333333-3333-3333-3333-333333333333"), {
      params: Promise.resolve({ id: "33333333-3333-3333-3333-333333333333" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcript).toHaveLength(1);
  });

  it("returns 404 for a meeting that doesn't exist", async () => {
    const res = await GET_ONE(new Request("http://localhost/api/meetings/does-not-exist"), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/meetings/:id", () => {
  it("deletes an existing meeting and returns 204", async () => {
    await POST(new NextRequest("http://localhost/api/meetings", { method: "POST", body: JSON.stringify(meetingPayload()) }));

    const res = await DELETE_ONE(new Request("http://localhost/api/meetings/33333333-3333-3333-3333-333333333333", { method: "DELETE" }), {
      params: Promise.resolve({ id: "33333333-3333-3333-3333-333333333333" }),
    });
    expect(res.status).toBe(204);

    const getRes = await GET_ONE(new Request("http://localhost/api/meetings/33333333-3333-3333-3333-333333333333"), {
      params: Promise.resolve({ id: "33333333-3333-3333-3333-333333333333" }),
    });
    expect(getRes.status).toBe(404);
  });
});
