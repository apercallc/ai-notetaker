import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";

const session = vi.hoisted(() => ({ current: null as null | { userId: string; email: string; workspaceId: string; role: "owner" | "member" } }));

vi.mock("@/lib/managedAuth", () => ({
  getManagedSession: async () => session.current,
  managedUnauthorized: (requestId: string) => Response.json({ error: "managed session required", requestId }, { status: 401, headers: { "x-request-id": requestId } }),
}));

import { POST } from "./route";

let workspaceId: string;
const userId = "managed-route-user";

beforeEach(async () => {
  workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: "Meeting API route test" } });
  session.current = { userId, email: "route@example.com", workspaceId, role: "owner" };
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { name: "Meeting API route test" } });
  await prisma.$disconnect();
});

function request(body: unknown) {
  return new Request("https://app.example.test/api/v1/meetings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "meeting-route-test" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/meetings", () => {
  it("requires a managed session and registers a meeting under that session's workspace and user", async () => {
    session.current = null;
    expect((await POST(request({}))).status).toBe(401);

    session.current = { userId, email: "route@example.com", workspaceId, role: "owner" };
    const input = {
      id: randomUUID(),
      title: "Managed check-in",
      startedAt: "2026-09-21T15:00:00.000Z",
      endedAt: "2026-09-21T15:30:00.000Z",
      summary: "",
      transcript: [],
      actionItems: [],
    };
    const response = await POST(request(input));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("meeting-route-test");
    expect(await response.json()).toMatchObject({ id: input.id, title: input.title });
    expect(await prisma.meeting.findUnique({ where: { id: input.id } })).toMatchObject({ userId, workspaceId, title: input.title });
  });

  it("returns a validation response for malformed meeting data", async () => {
    const response = await POST(request({ id: "bad" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "startedAt must be an ISO 8601 string" });
  });
});
