import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCH } from "./[id]/route";
import { createApiToken, DESKTOP_NOTES_SCOPE } from "@/lib/apiTokens";
import { upsertMeeting } from "@/lib/meetings";
import { prisma } from "@/lib/db";

const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const MEETING_ID = randomUUID();
const ITEM_ID = randomUUID();
let token: string;

const call = (id: string, body: unknown, bearer = token) =>
  PATCH(
    new Request(`http://localhost/api/v1/desktop-sync/action-items/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(async () => {
  await prisma.workspace.createMany({ data: [{ id: WORKSPACE_ID, name: "Actions ws" }, { id: OTHER_WORKSPACE_ID, name: "Other ws" }] });
  await prisma.user.create({ data: { id: USER_ID, email: "actions-sync@example.com", passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.workspaceMembership.create({ data: { userId: USER_ID, workspaceId: WORKSPACE_ID, role: "owner" } });
  token = (await createApiToken(USER_ID, { scope: DESKTOP_NOTES_SCOPE, workspaceId: WORKSPACE_ID })).token;
  await upsertMeeting(
    {
      id: MEETING_ID,
      title: "Planning",
      startedAt: "2026-10-01T10:00:00Z",
      endedAt: "2026-10-01T10:30:00Z",
      summary: "s",
      transcript: [{ speaker: "you", text: "hi", timestamp: null }],
      actionItems: [{ id: ITEM_ID, text: "Send the quote", owner: null }],
    },
    WORKSPACE_ID,
    USER_ID,
  );
});

afterEach(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
});

describe("desktop action item status", () => {
  it("marks an item done and open again, and bumps the note version so other devices refresh", async () => {
    const before = await prisma.meeting.findUniqueOrThrow({ where: { id: MEETING_ID }, select: { updatedAt: true } });
    expect((await call(ITEM_ID, { status: "done" })).status).toBe(200);
    const done = await prisma.actionItem.findUniqueOrThrow({ where: { id: ITEM_ID } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const after = await prisma.meeting.findUniqueOrThrow({ where: { id: MEETING_ID }, select: { updatedAt: true } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    expect((await call(ITEM_ID, { status: "open" })).status).toBe(200);
    const reopened = await prisma.actionItem.findUniqueOrThrow({ where: { id: ITEM_ID } });
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();
  });

  it("rejects bad input, unknown items, and other workspaces' tokens", async () => {
    expect((await call(ITEM_ID, { status: "finished" })).status).toBe(400);
    expect((await call(randomUUID(), { status: "done" })).status).toBe(404);
    expect((await call(ITEM_ID, { status: "done" }, "not-a-token")).status).toBe(401);
    const otherUser = randomUUID();
    await prisma.user.create({ data: { id: otherUser, email: "actions-sync-other@example.com", passwordHash: "x", emailVerifiedAt: new Date() } });
    await prisma.workspaceMembership.create({ data: { userId: otherUser, workspaceId: OTHER_WORKSPACE_ID, role: "owner" } });
    const otherToken = (await createApiToken(otherUser, { scope: DESKTOP_NOTES_SCOPE, workspaceId: OTHER_WORKSPACE_ID })).token;
    expect((await call(ITEM_ID, { status: "done" }, otherToken)).status).toBe(404);
    expect((await prisma.actionItem.findUniqueOrThrow({ where: { id: ITEM_ID } })).status).toBe("open");
    await prisma.user.delete({ where: { id: otherUser } });
  });
});
